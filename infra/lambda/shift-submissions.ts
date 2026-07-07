import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand
} from "@aws-sdk/lib-dynamodb";
import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminUpdateUserAttributesCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CostExplorerClient,
  GetCostAndUsageCommand
} from "@aws-sdk/client-cost-explorer";
import {
  CloudWatchClient,
  GetMetricStatisticsCommand
} from "@aws-sdk/client-cloudwatch";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

const TABLE_NAME = process.env.TABLE_NAME;
const CORS_ORIGINS =
  process.env.CORS_ORIGINS ?? process.env.CORS_ORIGIN ?? "*";
const USER_POOL_ID = process.env.USER_POOL_ID;
const ADMIN_GROUP_NAME = process.env.ADMIN_GROUP_NAME ?? "admins";
const FUNCTION_NAME =
  process.env.FUNCTION_NAME ?? process.env.AWS_LAMBDA_FUNCTION_NAME;
const LAMBDA_MEMORY_MB = Number(process.env.LAMBDA_MEMORY_MB ?? "128");
const SITE_DISTRIBUTION_ID = process.env.SITE_DISTRIBUTION_ID;
const ADMIN_DISTRIBUTION_ID = process.env.ADMIN_DISTRIBUTION_ID;
const WAF_ENABLED = process.env.WAF_ENABLED === "true";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_KEY_PARAMETER =
  process.env.GEMINI_API_KEY_PARAMETER ?? "/shift-app/gemini/api-key";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true
  }
});
const cognitoClient = new CognitoIdentityProviderClient({});
const costExplorerClient = new CostExplorerClient({ region: "us-east-1" });
const cloudWatchClient = new CloudWatchClient({});
const cloudWatchGlobalClient = new CloudWatchClient({ region: "us-east-1" });
const ssmClient = new SSMClient({});
const TTL_MONTHS = 12;
const SUBMISSION_ROLES = ["ホール", "キッチン", "どちらでも"] as const;
const ASSIGNMENT_ROLES = ["ホール", "キッチン"] as const;

const PRICING = {
  currency: "USD",
  usdToJpy: 156,
  lambdaRequestPerMillion: 0.2,
  lambdaGbSecond: 0.0000166667,
  apiGatewayRestRequestPerMillion: 3.5,
  dynamoReadUnitPerMillion: 0.155,
  dynamoWriteUnitPerMillion: 0.78,
  cloudFrontRequestPerTenThousand: 0.01,
  cloudFrontDataTransferPerGb: 0.114,
  wafWebAclMonthly: 5,
  wafRuleMonthly: 1,
  wafRequestPerMillion: 0.6,
  wafWebAclCount: 1,
  wafRuleCount: 2,
  label: "ap-northeast-1の概算単価。CloudFrontは日本向け配信の目安。"
} as const;

type SubmissionItem = {
  pk: string;
  sk: string;
  userId: string;
  name: string;
  rolePreference: string;
  slotsByDate: Record<string, string[]>;
  updatedAt: string;
  expiresAt?: number;
};

type AssignmentItem = {
  pk: string;
  sk: string;
  date: string;
  time: string;
  role: string;
  staffId: string;
  staffName: string;
  updatedAt: string;
  expiresAt?: number;
};

type PublishItem = {
  pk: string;
  sk: string;
  status: "draft" | "published";
  publishedAt?: string;
  publishedBy?: string;
  expiresAt?: number;
};

function resolveCorsOrigin(event: any): string {
  const requestOrigin = event?.headers?.origin ?? event?.headers?.Origin;
  const origins = CORS_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (origins.includes("*")) {
    return "*";
  }

  if (requestOrigin && origins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return origins[0] ?? "*";
}

function response(event: any, statusCode: number, body: object) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": resolveCorsOrigin(event),
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      Vary: "Origin"
    },
    body: JSON.stringify(body)
  };
}

function getClaims(event: any): Record<string, unknown> {
  const authorizer = event?.requestContext?.authorizer;
  const claims = (authorizer?.claims ?? {}) as Record<string, unknown>;
  if (typeof claims.sub === "string" && claims.sub) {
    return claims;
  }
  if (!authorizer) {
    return {};
  }
  const token = getAuthorizationToken(event);
  if (!token) {
    return {};
  }
  return decodeJwtClaims(token);
}

function getAuthorizationToken(event: any): string | null {
  const header =
    event?.headers?.Authorization ?? event?.headers?.authorization ?? "";
  const match = typeof header === "string" && header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function decodeJwtClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) {
    return {};
  }
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(
      payload.length + ((4 - (payload.length % 4)) % 4),
      "="
    );
    const json = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getRoute(event: any): string {
  return event?.resource ?? event?.path ?? "";
}

function getStringClaim(
  claims: Record<string, unknown>,
  key: string
): string | undefined {
  const value = claims[key];
  return typeof value === "string" ? value : undefined;
}

function getRole(claims: Record<string, unknown>): string | undefined {
  return getStringClaim(claims, "custom:role") ?? getStringClaim(claims, "role");
}

function getGroups(claims: Record<string, unknown>): string[] {
  const raw = claims["cognito:groups"];
  if (Array.isArray(raw)) {
    return raw.filter((value) => typeof value === "string") as string[];
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  }
  return [];
}

function isAdmin(claims: Record<string, unknown>): boolean {
  return getGroups(claims).includes(ADMIN_GROUP_NAME);
}

function isValidMonth(month: string | undefined): boolean {
  return typeof month === "string" && /^\d{4}-\d{2}$/.test(month);
}

function isValidDate(value: string | undefined): boolean {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isSubmissionRole(value: unknown): value is (typeof SUBMISSION_ROLES)[number] {
  return typeof value === "string" && SUBMISSION_ROLES.includes(value as any);
}

function isAssignmentRole(value: unknown): value is (typeof ASSIGNMENT_ROLES)[number] {
  return typeof value === "string" && ASSIGNMENT_ROLES.includes(value as any);
}

function parseJsonBody(event: any): any {
  if (!event?.body) {
    return {};
  }
  try {
    return JSON.parse(event.body);
  } catch {
    return null;
  }
}

function computeExpiresAt(month: string): number {
  const [year, monthIndex] = month.split("-").map(Number);
  const targetMonthIndex = monthIndex - 1 + TTL_MONTHS;
  const expiresAt = new Date(Date.UTC(year, targetMonthIndex + 1, 0, 23, 59, 59));
  return Math.floor(expiresAt.getTime() / 1000);
}

function getRecentMonths(count: number, baseDate = new Date()): string[] {
  const months: string[] = [];
  const start = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1));
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - offset, 1));
    const year = date.getUTCFullYear();
    const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
    months.push(`${year}-${month}`);
  }
  return months;
}

function formatCostDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMonthCostWindow(baseDate = new Date()) {
  const start = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), 1));
  const end = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + 1));
  const monthEnd = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + 1, 1));
  const elapsedDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
  );
  const daysInMonth = Math.ceil(
    (monthEnd.getTime() - start.getTime()) / (24 * 60 * 60 * 1000)
  );
  return {
    start: formatCostDate(start),
    end: formatCostDate(end),
    elapsedDays,
    daysInMonth
  };
}

type MetricDimension = {
  Name: string;
  Value: string;
};

async function getMetricSum(params: {
  cloudWatch: CloudWatchClient;
  namespace: string;
  metricName: string;
  dimensions: MetricDimension[];
  startTime: Date;
  endTime: Date;
  period?: number;
}): Promise<number> {
  if (params.dimensions.some((dimension) => !dimension.Value)) {
    return 0;
  }

  const result = await params.cloudWatch.send(
    new GetMetricStatisticsCommand({
      Namespace: params.namespace,
      MetricName: params.metricName,
      Dimensions: params.dimensions,
      StartTime: params.startTime,
      EndTime: params.endTime,
      Period: params.period ?? 3600,
      Statistics: ["Sum"]
    })
  );

  return (result.Datapoints ?? []).reduce(
    (total, point) => total + (point.Sum ?? 0),
    0
  );
}

function roundCost(value: number): number {
  return Number(value.toFixed(8));
}

function buildEstimateService(params: {
  service: string;
  amountUsd: number;
  usage: number;
  unit: string;
  detail: string;
}) {
  return {
    service: params.service,
    amountUsd: roundCost(Math.max(0, params.amountUsd)),
    usage: Math.round(params.usage * 100) / 100,
    unit: params.unit,
    detail: params.detail
  };
}

async function buildRealtimeCostEstimate(costWindow: ReturnType<typeof getMonthCostWindow>) {
  const startTime = new Date(`${costWindow.start}T00:00:00Z`);
  const endTime = new Date();
  const elapsedHours = Math.max(
    1,
    (endTime.getTime() - startTime.getTime()) / (60 * 60 * 1000)
  );
  const monthHours = costWindow.daysInMonth * 24;
  const cloudFrontDistributionIds = [
    SITE_DISTRIBUTION_ID,
    ADMIN_DISTRIBUTION_ID
  ].filter(Boolean) as string[];

  const [
    lambdaInvocations,
    lambdaDurationMs,
    dynamoReadUnits,
    dynamoWriteUnits,
    cloudFrontRequests,
    cloudFrontBytesDownloaded
  ] = await Promise.all([
    FUNCTION_NAME
      ? getMetricSum({
          cloudWatch: cloudWatchClient,
          namespace: "AWS/Lambda",
          metricName: "Invocations",
          dimensions: [{ Name: "FunctionName", Value: FUNCTION_NAME }],
          startTime,
          endTime
        })
      : Promise.resolve(0),
    FUNCTION_NAME
      ? getMetricSum({
          cloudWatch: cloudWatchClient,
          namespace: "AWS/Lambda",
          metricName: "Duration",
          dimensions: [{ Name: "FunctionName", Value: FUNCTION_NAME }],
          startTime,
          endTime
        })
      : Promise.resolve(0),
    TABLE_NAME
      ? getMetricSum({
          cloudWatch: cloudWatchClient,
          namespace: "AWS/DynamoDB",
          metricName: "ConsumedReadCapacityUnits",
          dimensions: [{ Name: "TableName", Value: TABLE_NAME }],
          startTime,
          endTime
        })
      : Promise.resolve(0),
    TABLE_NAME
      ? getMetricSum({
          cloudWatch: cloudWatchClient,
          namespace: "AWS/DynamoDB",
          metricName: "ConsumedWriteCapacityUnits",
          dimensions: [{ Name: "TableName", Value: TABLE_NAME }],
          startTime,
          endTime
        })
      : Promise.resolve(0),
    Promise.all(
      cloudFrontDistributionIds.map((distributionId) =>
        getMetricSum({
          cloudWatch: cloudWatchGlobalClient,
          namespace: "AWS/CloudFront",
          metricName: "Requests",
          dimensions: [
            { Name: "DistributionId", Value: distributionId },
            { Name: "Region", Value: "Global" }
          ],
          startTime,
          endTime
        })
      )
    ).then((values) => values.reduce((total, value) => total + value, 0)),
    Promise.all(
      cloudFrontDistributionIds.map((distributionId) =>
        getMetricSum({
          cloudWatch: cloudWatchGlobalClient,
          namespace: "AWS/CloudFront",
          metricName: "BytesDownloaded",
          dimensions: [
            { Name: "DistributionId", Value: distributionId },
            { Name: "Region", Value: "Global" }
          ],
          startTime,
          endTime
        })
      )
    ).then((values) => values.reduce((total, value) => total + value, 0))
  ]);

  const lambdaGbSeconds =
    (lambdaDurationMs / 1000) * (LAMBDA_MEMORY_MB / 1024);
  const lambdaCost =
    (lambdaInvocations / 1_000_000) * PRICING.lambdaRequestPerMillion +
    lambdaGbSeconds * PRICING.lambdaGbSecond;
  const apiGatewayCost =
    (lambdaInvocations / 1_000_000) *
    PRICING.apiGatewayRestRequestPerMillion;
  const dynamoCost =
    (dynamoReadUnits / 1_000_000) * PRICING.dynamoReadUnitPerMillion +
    (dynamoWriteUnits / 1_000_000) * PRICING.dynamoWriteUnitPerMillion;
  const cloudFrontGb = cloudFrontBytesDownloaded / 1024 / 1024 / 1024;
  const cloudFrontCost =
    (cloudFrontRequests / 10_000) * PRICING.cloudFrontRequestPerTenThousand +
    cloudFrontGb * PRICING.cloudFrontDataTransferPerGb;
  const services = [
    buildEstimateService({
      service: "AWS Lambda",
      amountUsd: lambdaCost,
      usage: lambdaInvocations,
      unit: "invocations",
      detail: `${Math.round(lambdaGbSeconds * 100) / 100} GB-seconds`
    }),
    buildEstimateService({
      service: "Amazon API Gateway",
      amountUsd: apiGatewayCost,
      usage: lambdaInvocations,
      unit: "estimated requests",
      detail: "Lambda呼び出し数からREST APIリクエスト数を推定"
    }),
    buildEstimateService({
      service: "Amazon DynamoDB",
      amountUsd: dynamoCost,
      usage: dynamoReadUnits + dynamoWriteUnits,
      unit: "capacity units",
      detail: `${Math.round(dynamoReadUnits * 100) / 100} read / ${Math.round(
        dynamoWriteUnits * 100
      ) / 100} write`
    }),
    buildEstimateService({
      service: "Amazon CloudFront",
      amountUsd: cloudFrontCost,
      usage: cloudFrontRequests,
      unit: "requests",
      detail: `${Math.round(cloudFrontGb * 10000) / 10000} GB downloaded`
    })
  ];

  if (WAF_ENABLED) {
    const wafRequests = lambdaInvocations;
    const wafVariableCost =
      (wafRequests / 1_000_000) * PRICING.wafRequestPerMillion;
    const wafFixedMonthToDateCost =
      ((PRICING.wafWebAclMonthly * PRICING.wafWebAclCount +
        PRICING.wafRuleMonthly * PRICING.wafRuleCount) *
        elapsedHours) /
      monthHours;
    const wafCost = wafFixedMonthToDateCost + wafVariableCost;
    services.push(
      buildEstimateService({
        service: "AWS WAF",
        amountUsd: wafCost,
        usage: wafRequests,
        unit: "estimated inspected requests",
        detail: "Web ACL 1個、ルール2個の月額固定費を時間按分"
      })
    );
  }

  services.sort((a, b) => b.amountUsd - a.amountUsd);

  const estimatedUsd = roundCost(
    services.reduce((total, item) => total + item.amountUsd, 0)
  );
  const projectedUsd = roundCost((estimatedUsd / elapsedHours) * monthHours);

  return {
    source: "CloudWatch",
    periodStart: costWindow.start,
    periodEnd: endTime.toISOString(),
    elapsedHours: Math.round(elapsedHours * 100) / 100,
    monthHours,
    estimatedUsd,
    projectedUsd,
    services,
    pricing: PRICING,
    wafEnabled: WAF_ENABLED,
    note:
      "CloudWatch metrics are near-real-time usage signals. This is an estimate and may differ from the final AWS bill."
  };
}

function mapItem(item: SubmissionItem) {
  return {
    userId: item.userId,
    name: item.name,
    rolePreference: item.rolePreference,
    slotsByDate: item.slotsByDate || {}
  };
}

function mapAdminSubmissionItem(item: SubmissionItem) {
  return {
    userId: item.userId,
    name: item.name,
    rolePreference: item.rolePreference,
    slotsByDate: item.slotsByDate || {},
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt
  };
}

function mapAdminAssignmentItem(item: AssignmentItem) {
  return {
    date: item.date,
    time: item.time,
    role: item.role,
    staffId: item.staffId,
    staffName: item.staffName,
    updatedAt: item.updatedAt,
    expiresAt: item.expiresAt
  };
}

function chunkRequests<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function batchWriteRequests(requests: any[]): Promise<void> {
  const batches = chunkRequests(requests, 25);
  for (const batch of batches) {
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE_NAME as string]: batch
        }
      })
    );
  }
}

async function getPublishState(month: string): Promise<PublishItem> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: month,
        sk: "PUBLISH"
      }
    })
  );

  return (
    (result.Item as PublishItem | undefined) ?? {
      pk: month,
      sk: "PUBLISH",
      status: "draft"
    }
  );
}

type AgentStaffSummary = {
  alias: string;
  name: string;
  assignedCount: number;
  submittedCount: number;
};

type GeneratedAssignment = {
  date: string;
  time: string;
  role: string;
  staffId: string;
  staffName: string;
};

type GenerateShortage = {
  date: string;
  time: string;
  requiredCount: number;
  assignedCount: number;
  shortageCount: number;
  availableCount: number;
};

type StaffingRules = {
  defaultStaffPerSlot: number;
  weekdayStaffPerSlot: number;
  weekendStaffPerSlot: number;
  dateOverrides: Record<string, number>;
};

function staffAlias(index: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (index < alphabet.length) {
    return `スタッフ${alphabet[index]}`;
  }
  return `スタッフ${index + 1}`;
}

function getDatesInMonth(month: string): string[] {
  const [year, monthValue] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthValue, 0)).getUTCDate();
  return Array.from({ length: lastDay }, (_, index) => {
    const day = `${index + 1}`.padStart(2, "0");
    return `${month}-${day}`;
  });
}

function normalizeStaffingRules(input: any, fallback: number): StaffingRules {
  const normalizeCount = (value: unknown, defaultValue: number) => {
    const numberValue = Number(value);
    return Number.isFinite(numberValue)
      ? Math.max(1, Math.min(10, Math.round(numberValue)))
      : defaultValue;
  };

  const defaultStaffPerSlot = normalizeCount(
    input?.defaultStaffPerSlot,
    fallback
  );
  const weekdayStaffPerSlot = normalizeCount(
    input?.weekdayStaffPerSlot,
    defaultStaffPerSlot
  );
  const weekendStaffPerSlot = normalizeCount(
    input?.weekendStaffPerSlot,
    defaultStaffPerSlot
  );
  const dateOverridesInput = input?.dateOverrides;
  const dateOverrides: Record<string, number> = {};

  if (dateOverridesInput && typeof dateOverridesInput === "object") {
    Object.entries(dateOverridesInput as Record<string, unknown>).forEach(
      ([date, count]) => {
        if (isValidDate(date)) {
          dateOverrides[date] = normalizeCount(count, defaultStaffPerSlot);
        }
      }
    );
  }

  return {
    defaultStaffPerSlot,
    weekdayStaffPerSlot,
    weekendStaffPerSlot,
    dateOverrides
  };
}

function getRequiredStaffForDate(date: string, rules: StaffingRules): number {
  const override = rules.dateOverrides[date];
  if (override) {
    return override;
  }

  const [year, month, day] = date.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6
    ? rules.weekendStaffPerSlot
    : rules.weekdayStaffPerSlot;
}

function roleMatchesPreference(role: string, rolePreference: string): boolean {
  return rolePreference === role || rolePreference === "どちらでも";
}

function chooseRoleForCandidate(params: {
  candidate: SubmissionItem;
  targetRole: string;
  roleCounts: Map<string, number>;
  roles: string[];
}) {
  if (roleMatchesPreference(params.targetRole, params.candidate.rolePreference)) {
    return params.targetRole;
  }

  const preferredRoles = params.roles.filter((role) =>
    roleMatchesPreference(role, params.candidate.rolePreference)
  );
  if (preferredRoles.length === 0) {
    return params.targetRole;
  }

  return preferredRoles.sort(
    (a, b) =>
      (params.roleCounts.get(a) ?? 0) - (params.roleCounts.get(b) ?? 0) ||
      a.localeCompare(b, "ja")
  )[0];
}

function generateAssignmentDraft(params: {
  month: string;
  minStaffPerSlot: number;
  staffingRules: StaffingRules;
  roles: string[];
  submissions: SubmissionItem[];
}) {
  const slotMap = new Map<string, SubmissionItem[]>();
  const submittedCounts = new Map<string, number>();

  params.submissions.forEach((submission) => {
    Object.entries(submission.slotsByDate ?? {}).forEach(([date, times]) => {
      if (!date.startsWith(params.month)) {
        return;
      }
      times.forEach((time) => {
        const key = `${date}#${time}`;
        const list = slotMap.get(key) ?? [];
        list.push(submission);
        slotMap.set(key, list);
        submittedCounts.set(
          submission.userId,
          (submittedCounts.get(submission.userId) ?? 0) + 1
        );
      });
    });
  });

  const assignments: GeneratedAssignment[] = [];
  const shortages: GenerateShortage[] = [];
  const assignedCounts = new Map<string, number>();
  const dailyCounts = new Map<string, number>();
  const roleCounts = new Map<string, number>();

  Array.from(slotMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, candidates]) => {
      const [date, time] = key.split("#");
      const assignedInSlot = new Set<string>();
      const targetCount = getRequiredStaffForDate(date, params.staffingRules);

      for (let index = 0; index < targetCount; index += 1) {
        const targetRole = params.roles[index % params.roles.length];
        const selected = candidates
          .filter((candidate) => !assignedInSlot.has(candidate.userId))
          .map((candidate) => {
            const exactRole = candidate.rolePreference === targetRole;
            const canTargetRole = roleMatchesPreference(
              targetRole,
              candidate.rolePreference
            );
            const assignedCount = assignedCounts.get(candidate.userId) ?? 0;
            const dailyCount = dailyCounts.get(`${candidate.userId}#${date}`) ?? 0;
            const submittedCount = submittedCounts.get(candidate.userId) ?? 0;
            const roleLoad = roleCounts.get(`${candidate.userId}#${targetRole}`) ?? 0;
            const score =
              assignedCount * 10 +
              dailyCount * 6 +
              roleLoad * 3 -
              submittedCount * 0.05 -
              (exactRole ? 4 : canTargetRole ? 2 : 0);

            return { candidate, score };
          })
          .sort(
            (a, b) =>
              a.score - b.score ||
              a.candidate.name.localeCompare(b.candidate.name, "ja")
          )[0]?.candidate;

        if (!selected) {
          break;
        }

        const role = chooseRoleForCandidate({
          candidate: selected,
          targetRole,
          roleCounts,
          roles: params.roles
        });

        assignments.push({
          date,
          time,
          role,
          staffId: selected.userId,
          staffName: selected.name
        });
        assignedInSlot.add(selected.userId);
        assignedCounts.set(
          selected.userId,
          (assignedCounts.get(selected.userId) ?? 0) + 1
        );
        dailyCounts.set(
          `${selected.userId}#${date}`,
          (dailyCounts.get(`${selected.userId}#${date}`) ?? 0) + 1
        );
        roleCounts.set(
          `${selected.userId}#${role}`,
          (roleCounts.get(`${selected.userId}#${role}`) ?? 0) + 1
        );
      }

      if (assignedInSlot.size < targetCount) {
        shortages.push({
          date,
          time,
          requiredCount: targetCount,
          assignedCount: assignedInSlot.size,
          shortageCount: targetCount - assignedInSlot.size,
          availableCount: candidates.length
        });
      }
    });

  const staffLoads = params.submissions
    .map((submission) => ({
      staffId: submission.userId,
      staffName: submission.name,
      assignedCount: assignedCounts.get(submission.userId) ?? 0,
      submittedCount: submittedCounts.get(submission.userId) ?? 0
    }))
    .sort(
      (a, b) =>
        b.assignedCount - a.assignedCount ||
        b.submittedCount - a.submittedCount ||
        a.staffName.localeCompare(b.staffName, "ja")
    );

  return {
    assignments,
    shortages,
    staffLoads,
    rules: {
      minStaffPerSlot: params.minStaffPerSlot,
      staffingRules: params.staffingRules,
      roles: params.roles,
      source: "submitted availability only",
      strategy:
        "希望提出がある枠だけを対象に、勤務回数が少ないスタッフと役割希望に合うスタッフを優先して割当"
    }
  };
}

function buildAgentDataset(params: {
  month: string;
  minStaffPerSlot: number;
  assignments: AssignmentItem[];
  submissions: SubmissionItem[];
}) {
  const staffMap = new Map<
    string,
    {
      alias: string;
      name: string;
      assignedCount: number;
      submittedCount: number;
      submittedSlots: Set<string>;
    }
  >();

  const ensureStaff = (staffId: string, name: string) => {
    const existing = staffMap.get(staffId);
    if (existing) {
      if (name) {
        existing.name = name;
      }
      return existing;
    }
    const item = {
      alias: staffAlias(staffMap.size),
      name: name || "スタッフ",
      assignedCount: 0,
      submittedCount: 0,
      submittedSlots: new Set<string>()
    };
    staffMap.set(staffId, item);
    return item;
  };

  params.submissions.forEach((submission) => {
    const staff = ensureStaff(submission.userId, submission.name);
    Object.entries(submission.slotsByDate ?? {}).forEach(([date, times]) => {
      times.forEach((time) => {
        staff.submittedSlots.add(`${date}#${time}`);
      });
    });
    staff.submittedCount = staff.submittedSlots.size;
  });

  params.assignments.forEach((assignment) => {
    const staff = ensureStaff(assignment.staffId, assignment.staffName);
    staff.assignedCount += 1;
  });

  const slotMap = new Map<
    string,
    {
      date: string;
      time: string;
      assigned: string[];
      available: string[];
    }
  >();

  const ensureSlot = (date: string, time: string) => {
    const key = `${date}#${time}`;
    const existing = slotMap.get(key);
    if (existing) {
      return existing;
    }
    const item = { date, time, assigned: [] as string[], available: [] as string[] };
    slotMap.set(key, item);
    return item;
  };

  params.submissions.forEach((submission) => {
    const staff = ensureStaff(submission.userId, submission.name);
    Object.entries(submission.slotsByDate ?? {}).forEach(([date, times]) => {
      times.forEach((time) => {
        const slot = ensureSlot(date, time);
        if (!slot.available.includes(staff.alias)) {
          slot.available.push(staff.alias);
        }
      });
    });
  });

  params.assignments.forEach((assignment) => {
    const staff = ensureStaff(assignment.staffId, assignment.staffName);
    const slot = ensureSlot(assignment.date, assignment.time);
    slot.assigned.push(`${staff.alias}/${assignment.role}`);
  });

  const staff = Array.from(staffMap.values())
    .map((item): AgentStaffSummary => ({
      alias: item.alias,
      name: item.name,
      assignedCount: item.assignedCount,
      submittedCount: item.submittedCount
    }))
    .sort((a, b) => b.assignedCount - a.assignedCount || a.alias.localeCompare(b.alias));

  const slots = Array.from(slotMap.values()).sort(
    (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)
  );
  const submissionDates = new Set<string>();
  const assignmentDates = new Set<string>();

  params.submissions.forEach((submission) => {
    Object.entries(submission.slotsByDate ?? {}).forEach(([date, times]) => {
      if (times.length > 0) {
        submissionDates.add(date);
      }
    });
  });

  params.assignments.forEach((assignment) => {
    assignmentDates.add(assignment.date);
  });

  const calendarDays = getDatesInMonth(params.month).map((date) => ({
    date,
    hasAnySubmission: submissionDates.has(date),
    hasAnyAssignment: assignmentDates.has(date),
    note: submissionDates.has(date)
      ? "この日は少なくとも1人がシフト希望を提出している"
      : "この日はシフト希望が1件も提出されていない"
  }));
  const noSubmissionDates = calendarDays
    .filter((day) => !day.hasAnySubmission)
    .map((day) => day.date);

  const shortages = slots
    .map((slot) => ({
      date: slot.date,
      time: slot.time,
      assignedCount: slot.assigned.length,
      requiredCount: params.minStaffPerSlot,
      shortageCount: Math.max(0, params.minStaffPerSlot - slot.assigned.length),
      assigned: slot.assigned,
      available: slot.available
    }))
    .filter((slot) => slot.shortageCount > 0)
    .sort(
      (a, b) =>
        b.shortageCount - a.shortageCount ||
        a.date.localeCompare(b.date) ||
        a.time.localeCompare(b.time)
    );

  const average =
    staff.length > 0
      ? staff.reduce((total, item) => total + item.assignedCount, 0) / staff.length
      : 0;
  const imbalances = staff
    .map((item) => ({
      alias: item.alias,
      assignedCount: item.assignedCount,
      submittedCount: item.submittedCount,
      differenceFromAverage: Number((item.assignedCount - average).toFixed(2))
    }))
    .sort((a, b) => b.differenceFromAverage - a.differenceFromAverage);

  const mismatches = params.assignments
    .filter((assignment) => {
      const staff = staffMap.get(assignment.staffId);
      return !staff?.submittedSlots.has(`${assignment.date}#${assignment.time}`);
    })
    .map((assignment) => ({
      date: assignment.date,
      time: assignment.time,
      role: assignment.role,
      staff: staffMap.get(assignment.staffId)?.alias ?? "不明"
    }));

  return {
    dataset: {
      month: params.month,
      minStaffPerSlot: params.minStaffPerSlot,
      domainRules: [
        "calendarDaysに存在し、hasAnySubmission=false の日は、その日について誰もシフト希望を提出していないことを意味する。",
        "slotsに存在しない日付・時間帯は、提出も割当も確認できないため、希望者がいると推測してはいけない。",
        "availableが空の不足枠は、希望提出者がいない不足であり、追加募集または個別確認が必要。",
        "mismatchAssignmentsは、割当はあるが本人の提出希望に含まれていない可能性がある枠である。",
        "質問で特定の日付を聞かれた場合、その日がnoSubmissionDatesに含まれるなら、まず未提出日であることを伝える。"
      ],
      totals: {
        staff: staff.length,
        submissions: params.submissions.length,
        assignments: params.assignments.length,
        slots: slots.length,
        noSubmissionDates: noSubmissionDates.length
      },
      calendarDays,
      noSubmissionDates,
      staff: staff.map(({ alias, assignedCount, submittedCount }) => ({
        alias,
        assignedCount,
        submittedCount
      })),
      shortages: shortages.slice(0, 30),
      imbalances: imbalances.slice(0, 30),
      mismatchAssignments: mismatches.slice(0, 30)
    },
    aliases: staff.map(({ alias, name }) => ({ alias, name }))
  };
}

function restoreStaffNames(text: string, aliases: Array<{ alias: string; name: string }>): string {
  return aliases.reduce((current, item) => {
    return current.replaceAll(item.alias, item.name);
  }, text);
}

async function getGeminiApiKey(): Promise<string> {
  if (GEMINI_API_KEY) {
    return GEMINI_API_KEY;
  }

  const result = await ssmClient.send(
    new GetParameterCommand({
      Name: GEMINI_API_KEY_PARAMETER,
      WithDecryption: true
    })
  );
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  return value;
}

async function buildGeminiAgentAnswer(params: {
  month: string;
  question: string;
  minStaffPerSlot: number;
  assignments: AssignmentItem[];
  submissions: SubmissionItem[];
}) {
  const { dataset, aliases } = buildAgentDataset(params);
  const apiKey = await getGeminiApiKey();
  const google = createGoogleGenerativeAI({ apiKey });
  const result = await generateText({
    model: google(GEMINI_MODEL),
    temperature: 0.2,
    system:
      [
        "あなたは飲食店のシフト管理を支援するAIエージェントです。",
        "渡されるデータは匿名化済みです。店長がすぐ判断できるように、短く具体的な日本語で回答してください。",
        "このアプリでは、シフト希望は提出された日付・時間帯だけがslotsに現れます。",
        "calendarDaysに存在し、hasAnySubmission=false の日は、その日について誰もシフト希望を提出していない日です。",
        "slotsに存在しない日付・時間帯について、希望者や割当があると推測してはいけません。",
        "availableが空の不足枠は、希望提出者がいない不足として扱い、追加募集または個別確認を提案してください。",
        "mismatchAssignmentsは、本人の提出希望に含まれていない可能性がある割当です。断定せず、本人確認が必要と表現してください。",
        "質問で特定の日付を聞かれ、その日がnoSubmissionDatesに含まれる場合は、まずシフト希望が未提出であることを伝えてください。",
        "存在しないデータを推測で作らないでください。"
      ].join("\n"),
    prompt: [
      `質問: ${params.question}`,
      "匿名化済みシフトデータ:",
      JSON.stringify(dataset, null, 2),
      "回答形式:",
      "1. 結論",
      "2. 確認できた問題",
      "3. 修正案"
    ].join("\n")
  });

  return {
    answer: restoreStaffNames(result.text.trim(), aliases),
    source: "gemini",
    model: GEMINI_MODEL,
    anonymized: true,
    totals: dataset.totals
  };
}

async function explainGeneratedAssignments(params: {
  month: string;
  minStaffPerSlot: number;
  assignments: GeneratedAssignment[];
  shortages: GenerateShortage[];
  staffLoads: Array<{
    staffId: string;
    staffName: string;
    assignedCount: number;
    submittedCount: number;
  }>;
}) {
  const aliasByStaffId = new Map<string, { alias: string; name: string }>();
  params.staffLoads.forEach((staff, index) => {
    aliasByStaffId.set(staff.staffId, {
      alias: staffAlias(index),
      name: staff.staffName
    });
  });

  const anonymized = {
    month: params.month,
    minStaffPerSlot: params.minStaffPerSlot,
    totals: {
      assignments: params.assignments.length,
      shortages: params.shortages.length,
      staff: params.staffLoads.length
    },
    staffLoads: params.staffLoads.map((staff) => ({
      staff: aliasByStaffId.get(staff.staffId)?.alias ?? "不明",
      assignedCount: staff.assignedCount,
      submittedCount: staff.submittedCount
    })),
    shortages: params.shortages.slice(0, 30),
    sampleAssignments: params.assignments.slice(0, 40).map((assignment) => ({
      date: assignment.date,
      time: assignment.time,
      role: assignment.role,
      staff: aliasByStaffId.get(assignment.staffId)?.alias ?? "不明"
    }))
  };

  try {
    const apiKey = await getGeminiApiKey();
    const google = createGoogleGenerativeAI({ apiKey });
    const result = await generateText({
      model: google(GEMINI_MODEL),
      temperature: 0.2,
      system: [
        "あなたは飲食店のシフト自動作成を支援するAIエージェントです。",
        "割当決定はすでにプログラムが行っています。あなたは生成案の理由、問題点、店長が確認すべき点を短く説明してください。",
        "渡されるスタッフ名は匿名化済みです。存在しないデータを推測しないでください。",
        "不足がある場合は、追加募集または個別確認が必要と伝えてください。"
      ].join("\n"),
      prompt: [
        "生成されたシフト案の要約:",
        JSON.stringify(anonymized, null, 2),
        "回答形式:",
        "1. 作成方針",
        "2. 注意点",
        "3. 店長への確認事項"
      ].join("\n")
    });

    const aliases = Array.from(aliasByStaffId.values());
    return restoreStaffNames(result.text.trim(), aliases);
  } catch (err) {
    console.error("assignment generation explanation error:", err);
    if (params.shortages.length > 0) {
      return `希望シフトをもとに ${params.assignments.length} 件の割当案を作成しました。不足している時間帯が ${params.shortages.length} 件あるため、追加募集または個別確認が必要です。`;
    }
    return `希望シフトをもとに ${params.assignments.length} 件の割当案を作成しました。店長が内容を確認してから保存してください。`;
  }
}

function getAgentErrorResponse(err: unknown) {
  const text = String(err);
  if (
    text.includes("RESOURCE_EXHAUSTED") ||
    text.includes("quota") ||
    text.includes("Quota exceeded")
  ) {
    return {
      statusCode: 429,
      message:
        "Gemini APIの利用上限に達している、または現在のプロジェクトで対象モデルの無料枠が有効ではありません。Google AI StudioでAPIキーのプロジェクト、無料枠、課金設定、モデルの利用可否を確認してください。"
    };
  }

  if (
    err instanceof Error &&
    (err.message === "GEMINI_API_KEY is not configured." ||
      err.name === "ParameterNotFound")
  ) {
    return {
      statusCode: 500,
      message: `Gemini APIキーが設定されていません。SSM Parameter Storeに ${GEMINI_API_KEY_PARAMETER} をSecureStringで作成してください。`
    };
  }

  return {
    statusCode: 500,
    message: "AIアシスタントの回答生成に失敗しました。"
  };
}

export const handler = async (event: any) => {
  if (event.httpMethod === "OPTIONS") {
    return response(event, 200, { ok: true });
  }

  if (!TABLE_NAME) {
    return response(event, 500, { message: "TABLE_NAME is not configured." });
  }

  const claims = getClaims(event);
  const userId = getStringClaim(claims, "sub");
  const name =
    getStringClaim(claims, "name") ??
    getStringClaim(claims, "email") ??
    "スタッフ";
  const role = getRole(claims);
  const route = getRoute(event);
  const adminUser = isAdmin(claims);
  const normalizedRole = typeof role === "string" ? role.toLowerCase() : "";
  const isManager = normalizedRole === "manager" || normalizedRole === "店長" || adminUser;

  if (!userId) {
    return response(event, 401, { message: "Unauthorized" });
  }

  if (route.startsWith("/admin/")) {
    if (!adminUser) {
      return response(event, 403, { message: "管理者のみ操作できます。" });
    }

    if (route.endsWith("/admin/agent") && event.httpMethod === "POST") {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const month = body.month as string | undefined;
      const question = (body.question as string | undefined)?.trim();
      const minStaffPerSlotValue = Number(body.minStaffPerSlot ?? "2");
      const minStaffPerSlot = Number.isFinite(minStaffPerSlotValue)
        ? Math.max(1, Math.min(10, Math.round(minStaffPerSlotValue)))
        : 2;

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      if (!question) {
        return response(event, 400, { message: "question is required." });
      }

      try {
        const [submissionResult, assignmentResult] = await Promise.all([
          docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
              ExpressionAttributeValues: {
                ":pk": month,
                ":sk": "SUBMISSION#"
              }
            })
          ),
          docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
              ExpressionAttributeValues: {
                ":pk": month,
                ":sk": "ASSIGNMENT#"
              }
            })
          )
        ]);

        const result = await buildGeminiAgentAnswer({
          month,
          question,
          minStaffPerSlot,
          submissions: (submissionResult.Items ?? []) as SubmissionItem[],
          assignments: (assignmentResult.Items ?? []) as AssignmentItem[]
        });

        return response(event, 200, result);
      } catch (err) {
        console.error("agent POST error:", err);
        const errorResponse = getAgentErrorResponse(err);
        return response(event, errorResponse.statusCode, {
          message: errorResponse.message
        });
      }
    }

    if (route.endsWith("/admin/availability") && event.httpMethod === "GET") {
      const month = event.queryStringParameters?.month;
      const userIdFilter = event.queryStringParameters?.userId?.trim();
      const nameFilter = event.queryStringParameters?.name?.trim().toLowerCase();
      const roleFilter = event.queryStringParameters?.rolePreference;
      const dateFilter = event.queryStringParameters?.date;

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      if (dateFilter && !isValidDate(dateFilter)) {
        return response(event, 400, { message: "date is invalid (YYYY-MM-DD)." });
      }

      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
          ExpressionAttributeValues: {
            ":pk": month,
            ":sk": "SUBMISSION#"
          }
        })
      );

      let items = (result.Items ?? []).map((item) =>
        mapAdminSubmissionItem(item as SubmissionItem)
      );

      if (userIdFilter) {
        items = items.filter((item) => item.userId.includes(userIdFilter));
      }

      if (nameFilter) {
        items = items.filter((item) =>
          item.name.toLowerCase().includes(nameFilter)
        );
      }

      if (roleFilter) {
        items = items.filter((item) => item.rolePreference === roleFilter);
      }

      if (dateFilter) {
        items = items.filter(
          (item) => (item.slotsByDate?.[dateFilter] ?? []).length > 0
        );
      }

      return response(event, 200, { items });
    }

    if (route.endsWith("/admin/availability") && event.httpMethod === "POST") {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const month = body.month as string | undefined;
      const action = (body.action as string | undefined) ?? "upsert";

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      const expiresAt = computeExpiresAt(month);
      const updatedAt = new Date().toISOString();

      if (action === "upsert") {
        const payload = body.item ?? body;
        const targetUserId = payload.userId as string | undefined;
        const targetName = payload.name as string | undefined;
        const rolePreference = payload.rolePreference as string | undefined;
        const slotsByDate = payload.slotsByDate as
          | Record<string, string[]>
          | undefined;

        if (!targetUserId || !targetName || !isSubmissionRole(rolePreference)) {
          return response(event, 400, { message: "payload is invalid." });
        }

        const item: SubmissionItem = {
          pk: month,
          sk: `SUBMISSION#${targetUserId}`,
          userId: targetUserId,
          name: targetName,
          rolePreference,
          slotsByDate: slotsByDate ?? {},
          updatedAt,
          expiresAt
        };

        await docClient.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          })
        );

        return response(event, 200, { item: mapAdminSubmissionItem(item) });
      }

      if (action === "delete") {
        const targetUserId =
          (body.userId as string | undefined) ??
          (body.item?.userId as string | undefined);

        if (!targetUserId) {
          return response(event, 400, { message: "userId is required." });
        }

        await docClient.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: month,
              sk: `SUBMISSION#${targetUserId}`
            }
          })
        );

        return response(event, 200, { ok: true });
      }

      if (action === "bulkUpsert") {
        const items = body.items as Array<Record<string, unknown>> | undefined;
        if (!Array.isArray(items) || items.length === 0) {
          return response(event, 400, { message: "items is required." });
        }

        const requests = items.map((entry) => {
          const targetUserId = entry.userId as string | undefined;
          const targetName = entry.name as string | undefined;
          const rolePreference = entry.rolePreference as string | undefined;
          const slotsByDate = entry.slotsByDate as
            | Record<string, string[]>
            | undefined;

          if (!targetUserId || !targetName || !isSubmissionRole(rolePreference)) {
            return null;
          }

          const item: SubmissionItem = {
            pk: month,
            sk: `SUBMISSION#${targetUserId}`,
            userId: targetUserId,
            name: targetName,
            rolePreference,
            slotsByDate: slotsByDate ?? {},
            updatedAt,
            expiresAt
          };

          return {
            PutRequest: {
              Item: item
            }
          };
        });

        if (requests.some((request) => request === null)) {
          return response(event, 400, { message: "items format is invalid." });
        }

        const batches = chunkRequests(requests as any[], 25);
        for (const batch of batches) {
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: batch
              }
            })
          );
        }

        return response(event, 200, { ok: true, count: items.length });
      }

      if (action === "bulkDelete") {
        const userIds =
          (body.userIds as string[] | undefined) ??
          (Array.isArray(body.items)
            ? (body.items as Array<{ userId?: string }>).map(
                (item) => item.userId
              )
            : []);

        const normalized = userIds.filter(
          (value): value is string => typeof value === "string" && value.length > 0
        );

        if (normalized.length === 0) {
          return response(event, 400, { message: "userIds is required." });
        }

        const requests = normalized.map((targetUserId) => ({
          DeleteRequest: {
            Key: {
              pk: month,
              sk: `SUBMISSION#${targetUserId}`
            }
          }
        }));

        const batches = chunkRequests(requests, 25);
        for (const batch of batches) {
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: batch
              }
            })
          );
        }

        return response(event, 200, { ok: true, count: normalized.length });
      }

      return response(event, 400, { message: "action is invalid." });
    }

    if (route.endsWith("/admin/assignments") && event.httpMethod === "GET") {
      const month = event.queryStringParameters?.month;
      const dateFilter = event.queryStringParameters?.date;
      const roleFilter = event.queryStringParameters?.role;
      const staffIdFilter = event.queryStringParameters?.staffId;

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      if (dateFilter && !isValidDate(dateFilter)) {
        return response(event, 400, { message: "date is invalid (YYYY-MM-DD)." });
      }

      const result = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
          ExpressionAttributeValues: {
            ":pk": month,
            ":sk": "ASSIGNMENT#"
          }
        })
      );

      let items = (result.Items ?? []).map((item) =>
        mapAdminAssignmentItem(item as AssignmentItem)
      );

      if (dateFilter) {
        items = items.filter((item) => item.date === dateFilter);
      }

      if (roleFilter) {
        items = items.filter((item) => item.role === roleFilter);
      }

      if (staffIdFilter) {
        items = items.filter((item) => item.staffId === staffIdFilter);
      }

      return response(event, 200, { items });
    }

    if (
      route.endsWith("/admin/assignments/generate") &&
      event.httpMethod === "POST"
    ) {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const month = body.month as string | undefined;
      const minStaffPerSlotValue = Number(body.minStaffPerSlot ?? "2");
      const minStaffPerSlot = Number.isFinite(minStaffPerSlotValue)
        ? Math.max(1, Math.min(10, Math.round(minStaffPerSlotValue)))
        : 2;
      const staffingRules = normalizeStaffingRules(
        body.staffingRules,
        minStaffPerSlot
      );
      const rolesInput = body.roles as string[] | undefined;
      const roles =
        Array.isArray(rolesInput) && rolesInput.length > 0
          ? rolesInput.filter(isAssignmentRole)
          : [...ASSIGNMENT_ROLES];

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      if (roles.length === 0) {
        return response(event, 400, { message: "roles is invalid." });
      }

      const submissionResult = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
          ExpressionAttributeValues: {
            ":pk": month,
            ":sk": "SUBMISSION#"
          }
        })
      );

      const submissions = (submissionResult.Items ?? []) as SubmissionItem[];
      const draft = generateAssignmentDraft({
        month,
        minStaffPerSlot,
        staffingRules,
        roles,
        submissions
      });
      const explanation = await explainGeneratedAssignments({
        month,
        minStaffPerSlot,
        assignments: draft.assignments,
        shortages: draft.shortages,
        staffLoads: draft.staffLoads
      });

      return response(event, 200, {
        month,
        assignments: draft.assignments,
        shortages: draft.shortages,
        staffLoads: draft.staffLoads,
        explanation,
        rules: draft.rules,
        generatedAt: new Date().toISOString()
      });
    }

    if (route.endsWith("/admin/assignments") && event.httpMethod === "POST") {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const month = body.month as string | undefined;
      const action = (body.action as string | undefined) ?? "replace";

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      const expiresAt = computeExpiresAt(month);
      const updatedAt = new Date().toISOString();

      const toAssignmentItem = (assignment: any): AssignmentItem | null => {
        const date = assignment.date as string | undefined;
        const time = assignment.time as string | undefined;
        const roleValue = assignment.role as string | undefined;
        const staffId = assignment.staffId as string | undefined;
        const staffName = assignment.staffName as string | undefined;

        if (!date || !time || !roleValue || !staffId || !staffName) {
          return null;
        }

        if (!isAssignmentRole(roleValue)) {
          return null;
        }

        return {
          pk: month,
          sk: `ASSIGNMENT#${date}#${roleValue}#${time}#${staffId}`,
          date,
          time,
          role: roleValue,
          staffId,
          staffName,
          updatedAt,
          expiresAt
        };
      };

      if (action === "replace") {
        const assignments = body.assignments as any[] | undefined;
        if (!Array.isArray(assignments)) {
          return response(event, 400, { message: "assignments is required." });
        }

        const existing = await docClient.send(
          new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
            ExpressionAttributeValues: {
              ":pk": month,
              ":sk": "ASSIGNMENT#"
            }
          })
        );

        const deleteRequests = (existing.Items ?? []).map((item) => ({
          DeleteRequest: {
            Key: {
              pk: (item as { pk: string }).pk,
              sk: (item as { sk: string }).sk
            }
          }
        }));

        const putRequests = assignments
          .map((assignment) => {
            const item = toAssignmentItem(assignment);
            if (!item) {
              return null;
            }
            return {
              PutRequest: {
                Item: item
              }
            };
          })
          .filter(Boolean);

        if (assignments.length !== putRequests.length) {
          return response(event, 400, { message: "assignments format is invalid." });
        }

        await batchWriteRequests(deleteRequests);
        await batchWriteRequests(putRequests as any[]);

        return response(event, 200, { ok: true, count: putRequests.length });
      }

      if (action === "upsert") {
        const assignments = body.assignments as any[] | undefined;
        if (!Array.isArray(assignments) || assignments.length === 0) {
          return response(event, 400, { message: "assignments is required." });
        }

        const putRequests = assignments
          .map((assignment) => {
            const item = toAssignmentItem(assignment);
            if (!item) {
              return null;
            }
            return {
              PutRequest: {
                Item: item
              }
            };
          })
          .filter(Boolean);

        if (assignments.length !== putRequests.length) {
          return response(event, 400, { message: "assignments format is invalid." });
        }

        const batches = chunkRequests(putRequests as any[], 25);
        for (const batch of batches) {
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: batch
              }
            })
          );
        }

        return response(event, 200, { ok: true, count: putRequests.length });
      }

      if (action === "delete" || action === "bulkDelete") {
        const keys =
          (body.keys as Array<{ date?: string; time?: string; role?: string; staffId?: string }>) ??
          (Array.isArray(body.assignments)
            ? (body.assignments as Array<{ date?: string; time?: string; role?: string; staffId?: string }>).map(
                (assignment) => ({
                  date: assignment.date,
                  time: assignment.time,
                  role: assignment.role,
                  staffId: assignment.staffId
                })
              )
            : []);

        const deleteRequests = keys
          .map((entry) => {
            if (!entry.date || !entry.time || !entry.role || !entry.staffId) {
              return null;
            }
            if (!isAssignmentRole(entry.role)) {
              return null;
            }
            return {
              DeleteRequest: {
                Key: {
                  pk: month,
                  sk: `ASSIGNMENT#${entry.date}#${entry.role}#${entry.time}#${entry.staffId}`
                }
              }
            };
          })
          .filter(Boolean);

        if (deleteRequests.length === 0) {
          return response(event, 400, { message: "keys is required." });
        }

        const batches = chunkRequests(deleteRequests as any[], 25);
        for (const batch of batches) {
          await docClient.send(
            new BatchWriteCommand({
              RequestItems: {
                [TABLE_NAME]: batch
              }
            })
          );
        }

        return response(event, 200, { ok: true, count: deleteRequests.length });
      }

      return response(event, 400, { message: "action is invalid." });
    }

    if (route.endsWith("/admin/publish") && event.httpMethod === "GET") {
      const month = event.queryStringParameters?.month;

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      const publishState = await getPublishState(month);
      return response(event, 200, publishState);
    }

    if (route.endsWith("/admin/publish") && event.httpMethod === "POST") {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const month = body.month as string | undefined;
      const action = (body.action as string | undefined) ?? "set";

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      if (action === "delete") {
        await docClient.send(
          new DeleteCommand({
            TableName: TABLE_NAME,
            Key: {
              pk: month,
              sk: "PUBLISH"
            }
          })
        );

        return response(event, 200, { ok: true });
      }

      if (action === "set") {
        const status = body.status as "draft" | "published" | undefined;
        if (status !== "draft" && status !== "published") {
          return response(event, 400, { message: "status is invalid." });
        }

        const item: PublishItem = {
          pk: month,
          sk: "PUBLISH",
          status,
          publishedAt: status === "published" ? new Date().toISOString() : undefined,
          publishedBy: status === "published" ? userId : undefined,
          expiresAt: computeExpiresAt(month)
        };

        await docClient.send(
          new PutCommand({
            TableName: TABLE_NAME,
            Item: item
          })
        );

        return response(event, 200, item);
      }

      return response(event, 400, { message: "action is invalid." });
    }

    if (route.endsWith("/admin/users") && event.httpMethod === "GET") {
      if (!USER_POOL_ID) {
        return response(event, 500, { message: "USER_POOL_ID is not configured." });
      }

      const query = event.queryStringParameters?.query?.trim();
      const limitValue = Number(event.queryStringParameters?.limit ?? "20");
      const limit = Number.isFinite(limitValue) ? Math.max(1, Math.min(50, limitValue)) : 20;
      const paginationToken = event.queryStringParameters?.paginationToken;

      const input: any = {
        UserPoolId: USER_POOL_ID,
        Limit: limit
      };

      if (paginationToken) {
        input.PaginationToken = paginationToken;
      }

      if (query) {
        input.Filter = query.includes("@")
          ? `email ^= \"${query}\"`
          : `username ^= \"${query}\"`;
      }

      const result = await cognitoClient.send(new ListUsersCommand(input));
      const users = result.Users ?? [];

      const groups = await Promise.all(
        users.map(async (user) => {
          if (!user.Username) {
            return [] as string[];
          }
          const groupsResult = await cognitoClient.send(
            new AdminListGroupsForUserCommand({
              UserPoolId: USER_POOL_ID,
              Username: user.Username
            })
          );
          return (groupsResult.Groups ?? [])
            .map((group) => group.GroupName)
            .filter((value): value is string => typeof value === "string");
        })
      );

      const items = users.map((user, index) => {
        const attributes = (user.Attributes ?? []).reduce(
          (acc, attr) => {
            if (attr.Name && attr.Value) {
              acc[attr.Name] = attr.Value;
            }
            return acc;
          },
          {} as Record<string, string>
        );

        return {
          username: user.Username,
          userId: attributes.sub,
          enabled: user.Enabled ?? false,
          status: user.UserStatus,
          email: attributes.email,
          name: attributes.name,
          role: attributes["custom:role"],
          groups: groups[index] ?? [],
          createdAt: user.UserCreateDate?.toISOString(),
          updatedAt: user.UserLastModifiedDate?.toISOString()
        };
      });

      return response(event, 200, {
        users: items,
        nextToken: result.PaginationToken
      });
    }

    if (route.endsWith("/admin/users") && event.httpMethod === "POST") {
      if (!USER_POOL_ID) {
        return response(event, 500, { message: "USER_POOL_ID is not configured." });
      }

      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const username = body.username as string | undefined;
      const roleValue = body.role as string | undefined;
      const isAdminValue = body.isAdmin as boolean | undefined;

      if (!username) {
        return response(event, 400, { message: "username is required." });
      }

      if (roleValue) {
        if (roleValue !== "staff" && roleValue !== "manager") {
          return response(event, 400, { message: "role is invalid." });
        }

        await cognitoClient.send(
          new AdminUpdateUserAttributesCommand({
            UserPoolId: USER_POOL_ID,
            Username: username,
            UserAttributes: [
              {
                Name: "custom:role",
                Value: roleValue
              }
            ]
          })
        );
      }

      if (typeof isAdminValue === "boolean") {
        if (isAdminValue) {
          await cognitoClient.send(
            new AdminAddUserToGroupCommand({
              UserPoolId: USER_POOL_ID,
              Username: username,
              GroupName: ADMIN_GROUP_NAME
            })
          );
        } else {
          await cognitoClient.send(
            new AdminRemoveUserFromGroupCommand({
              UserPoolId: USER_POOL_ID,
              Username: username,
              GroupName: ADMIN_GROUP_NAME
            })
          );
        }
      }

      return response(event, 200, { ok: true });
    }

    if (route.endsWith("/admin/cost") && event.httpMethod === "GET") {
      const costWindow = getMonthCostWindow();
      const [result, realtimeEstimate] = await Promise.all([
        costExplorerClient.send(
          new GetCostAndUsageCommand({
            TimePeriod: {
              Start: costWindow.start,
              End: costWindow.end
            },
            Granularity: "MONTHLY",
            Metrics: ["UnblendedCost"],
            GroupBy: [
              {
                Type: "DIMENSION",
                Key: "SERVICE"
              }
            ]
          })
        ),
        buildRealtimeCostEstimate(costWindow)
      ]);

      const groups = result.ResultsByTime?.[0]?.Groups ?? [];
      const services = groups
        .map((group) => {
          const amount = Number(group.Metrics?.UnblendedCost?.Amount ?? "0");
          return {
            service: group.Keys?.[0] ?? "Unknown",
            amountUsd: Number.isFinite(amount) ? amount : 0
          };
        })
        .filter((item) => Math.abs(item.amountUsd) > 0.000001)
        .sort((a, b) => b.amountUsd - a.amountUsd);

      const actualUsd = Math.max(
        0,
        services.reduce((total, item) => total + item.amountUsd, 0)
      );
      const projectedUsd =
        (actualUsd / costWindow.elapsedDays) * costWindow.daysInMonth;

      return response(event, 200, {
        currency: "USD",
        periodStart: costWindow.start,
        periodEndExclusive: costWindow.end,
        elapsedDays: costWindow.elapsedDays,
        daysInMonth: costWindow.daysInMonth,
        actualUsd,
        projectedUsd,
        services,
        realtimeEstimate,
        updatedAt: new Date().toISOString(),
        note:
          "Cost Explorer data is delayed and is not a strict real-time bill."
      });
    }

    if (route.endsWith("/admin/ttl") && event.httpMethod === "POST") {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const action = (body.action as string | undefined) ?? "backfill";

      if (action === "backfill") {
        const monthsInput = body.months as string[] | undefined;
        const months = Array.isArray(monthsInput) && monthsInput.length > 0
          ? monthsInput
          : getRecentMonths(TTL_MONTHS);

        const normalized = months.filter((value) => isValidMonth(value));
        if (normalized.length === 0) {
          return response(event, 400, { message: "months is invalid." });
        }

        for (const month of normalized) {
          let lastKey: Record<string, any> | undefined;
          const expiresAt = computeExpiresAt(month);
          do {
            const result = await docClient.send(
              new QueryCommand({
                TableName: TABLE_NAME,
                KeyConditionExpression: "pk = :pk",
                ExpressionAttributeValues: {
                  ":pk": month
                },
                ExclusiveStartKey: lastKey
              })
            );

            const items = (result.Items ?? []).map((item) => ({
              ...item,
              expiresAt
            }));

            const requests = items.map((item) => ({
              PutRequest: {
                Item: item
              }
            }));

            const batches = chunkRequests(requests, 25);
            for (const batch of batches) {
              await docClient.send(
                new BatchWriteCommand({
                  RequestItems: {
                    [TABLE_NAME]: batch
                  }
                })
              );
            }

            lastKey = result.LastEvaluatedKey as Record<string, any> | undefined;
          } while (lastKey);
        }

        return response(event, 200, { ok: true, months: normalized });
      }

      if (action === "purge") {
        const cutoffMonth =
          (body.cutoffMonth as string | undefined) ?? getRecentMonths(TTL_MONTHS)[0];

        if (!isValidMonth(cutoffMonth)) {
          return response(event, 400, { message: "cutoffMonth is invalid." });
        }

        let lastKey: Record<string, any> | undefined;
        let deletedCount = 0;
        do {
          const result = await docClient.send(
            new ScanCommand({
              TableName: TABLE_NAME,
              FilterExpression: "pk < :cutoff",
              ExpressionAttributeValues: {
                ":cutoff": cutoffMonth
              },
              ExclusiveStartKey: lastKey
            })
          );

          const deleteRequests = (result.Items ?? []).map((item) => ({
            DeleteRequest: {
              Key: {
                pk: (item as { pk: string }).pk,
                sk: (item as { sk: string }).sk
              }
            }
          }));

          deletedCount += deleteRequests.length;
          const batches = chunkRequests(deleteRequests, 25);
          for (const batch of batches) {
            await docClient.send(
              new BatchWriteCommand({
                RequestItems: {
                  [TABLE_NAME]: batch
                }
              })
            );
          }

          lastKey = result.LastEvaluatedKey as Record<string, any> | undefined;
        } while (lastKey);

        return response(event, 200, { ok: true, deleted: deletedCount });
      }

      if (action === "summary" || action === "deleteMonth") {
        const month = body.month as string | undefined;
        if (!isValidMonth(month)) {
          return response(event, 400, { message: "month is required (YYYY-MM)." });
        }

        let lastKey: Record<string, any> | undefined;
        const items: Array<{ pk: string; sk: string }> = [];
        const counts = {
          submissions: 0,
          assignments: 0,
          publishStates: 0,
          other: 0
        };

        do {
          const result = await docClient.send(
            new QueryCommand({
              TableName: TABLE_NAME,
              KeyConditionExpression: "pk = :pk",
              ExpressionAttributeValues: {
                ":pk": month
              },
              ExclusiveStartKey: lastKey
            })
          );

          (result.Items ?? []).forEach((item) => {
            const record = item as { pk: string; sk: string };
            items.push(record);
            if (record.sk.startsWith("SUBMISSION#")) {
              counts.submissions += 1;
            } else if (record.sk.startsWith("ASSIGNMENT#")) {
              counts.assignments += 1;
            } else if (record.sk === "PUBLISH") {
              counts.publishStates += 1;
            } else {
              counts.other += 1;
            }
          });

          lastKey = result.LastEvaluatedKey as Record<string, any> | undefined;
        } while (lastKey);

        if (action === "summary") {
          return response(event, 200, {
            month,
            total: items.length,
            ...counts
          });
        }

        const deleteRequests = items.map((item) => ({
          DeleteRequest: {
            Key: {
              pk: item.pk,
              sk: item.sk
            }
          }
        }));

        await batchWriteRequests(deleteRequests);
        return response(event, 200, {
          ok: true,
          month,
          deleted: deleteRequests.length,
          ...counts
        });
      }

      return response(event, 400, { message: "action is invalid." });
    }

    return response(event, 405, { message: "Method not allowed." });
  }

  if (route.endsWith("/availability") && event.httpMethod === "GET") {
    const month = event.queryStringParameters?.month;
    const scope = event.queryStringParameters?.scope;

    if (!isValidMonth(month)) {
      return response(event, 400, { message: "month is required (YYYY-MM)." });
    }

    if (scope === "self") {
      const result = await docClient.send(
        new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: month,
            sk: `SUBMISSION#${userId}`
          }
        })
      );

      const item = result.Item as SubmissionItem | undefined;
      return response(event, 200, { items: item ? [mapItem(item)] : [] });
    }

    if (!isManager) {
      return response(event, 403, { message: "店長のみ提出一覧を取得できます。" });
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": month,
          ":sk": "SUBMISSION#"
        }
      })
    );

    const items = (result.Items ?? []).map((item) =>
      mapItem(item as SubmissionItem)
    );
    return response(event, 200, { items });
  }

  if (route.endsWith("/availability") && event.httpMethod === "POST") {
    const body = parseJsonBody(event);
    if (body === null) {
      return response(event, 400, { message: "Invalid JSON body." });
    }

    const { month, rolePreference, slotsByDate } = body;

    if (!isValidMonth(month)) {
      return response(event, 400, { message: "month is required (YYYY-MM)." });
    }

    if (!isSubmissionRole(rolePreference)) {
      return response(event, 400, { message: "rolePreference is invalid." });
    }

    const item: SubmissionItem = {
      pk: month,
      sk: `SUBMISSION#${userId}`,
      userId,
      name,
      rolePreference,
      slotsByDate: slotsByDate || {},
      updatedAt: new Date().toISOString(),
      expiresAt: computeExpiresAt(month)
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      })
    );

    return response(event, 200, { item: mapItem(item) });
  }

  if (route.endsWith("/assignments") && event.httpMethod === "GET") {
    const month = event.queryStringParameters?.month;

    if (!isValidMonth(month)) {
      return response(event, 400, { message: "month is required (YYYY-MM)." });
    }

    const publishState = await getPublishState(month);
    if (publishState.status !== "published" && !isManager) {
      return response(event, 403, { message: "まだ公開されていません。" });
    }

    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": month,
          ":sk": "ASSIGNMENT#"
        }
      })
    );

    const items = (result.Items ?? []).map((item) => {
      const assignment = item as AssignmentItem;
      return {
        date: assignment.date,
        time: assignment.time,
        role: assignment.role,
        staffId: assignment.staffId,
        staffName: assignment.staffName
      };
    });

    return response(event, 200, { status: publishState.status, items });
  }

  if (route.endsWith("/assignments/generate") && event.httpMethod === "POST") {
    if (!isManager) {
      return response(event, 403, { message: "店長のみ操作できます。" });
    }

    const body = parseJsonBody(event);
    if (body === null) {
      return response(event, 400, { message: "Invalid JSON body." });
    }

    const month = body.month as string | undefined;
    const minStaffPerSlotValue = Number(body.minStaffPerSlot ?? "2");
    const minStaffPerSlot = Number.isFinite(minStaffPerSlotValue)
      ? Math.max(1, Math.min(10, Math.round(minStaffPerSlotValue)))
      : 2;
    const staffingRules = normalizeStaffingRules(
      body.staffingRules,
      minStaffPerSlot
    );
    const rolesInput = body.roles as string[] | undefined;
    const roles =
      Array.isArray(rolesInput) && rolesInput.length > 0
        ? rolesInput.filter(isAssignmentRole)
        : [...ASSIGNMENT_ROLES];

    if (!isValidMonth(month)) {
      return response(event, 400, { message: "month is required (YYYY-MM)." });
    }

    if (roles.length === 0) {
      return response(event, 400, { message: "roles is invalid." });
    }

    const submissionResult = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": month,
          ":sk": "SUBMISSION#"
        }
      })
    );

    const submissions = (submissionResult.Items ?? []) as SubmissionItem[];
    const draft = generateAssignmentDraft({
      month,
      minStaffPerSlot,
      staffingRules,
      roles,
      submissions
    });
    const explanation = await explainGeneratedAssignments({
      month,
      minStaffPerSlot,
      assignments: draft.assignments,
      shortages: draft.shortages,
      staffLoads: draft.staffLoads
    });

    return response(event, 200, {
      month,
      assignments: draft.assignments,
      shortages: draft.shortages,
      staffLoads: draft.staffLoads,
      explanation,
      rules: draft.rules,
      generatedAt: new Date().toISOString()
    });
  }

  if (route.endsWith("/assignments") && event.httpMethod === "POST") {
    if (!isManager) {
      return response(event, 403, { message: "店長のみ操作できます。" });
    }
    try {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const { month, assignments } = body;

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      if (!Array.isArray(assignments)) {
        return response(event, 400, { message: "assignments is required." });
      }

      const existing = await docClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
          ExpressionAttributeValues: {
            ":pk": month,
            ":sk": "ASSIGNMENT#"
          }
        })
      );

      const deleteRequests = (existing.Items ?? []).map((item) => ({
        DeleteRequest: {
          Key: {
            pk: (item as { pk: string }).pk,
            sk: (item as { sk: string }).sk
          }
        }
      }));

      const putRequests = assignments.map((assignment: any) => {
        const date = assignment.date as string | undefined;
        const time = assignment.time as string | undefined;
        const roleValue = assignment.role as string | undefined;
        const staffId = assignment.staffId as string | undefined;
        const staffName = assignment.staffName as string | undefined;

        if (!date || !time || !roleValue || !staffId || !staffName) {
          return null;
        }

        if (!isAssignmentRole(roleValue)) {
          return null;
        }

        const item: AssignmentItem = {
          pk: month,
          sk: `ASSIGNMENT#${date}#${roleValue}#${time}#${staffId}`,
          date,
          time,
          role: roleValue,
          staffId,
          staffName,
          updatedAt: new Date().toISOString(),
          expiresAt: computeExpiresAt(month)
        };

        return {
          PutRequest: {
            Item: item
          }
        };
      });

      if (putRequests.some((request: any) => request === null)) {
        return response(event, 400, { message: "assignments format is invalid." });
      }

      await batchWriteRequests(deleteRequests);
      await batchWriteRequests(putRequests as any[]);

      return response(event, 200, { ok: true });
    } catch (err) {
      console.error("assignments POST error:", err);
      return response(event, 500, { message: "Internal Server Error", error: String(err) });
    }
  }

  if (route.endsWith("/publish") && event.httpMethod === "GET") {
    const month = event.queryStringParameters?.month;

    if (!isValidMonth(month)) {
      return response(event, 400, { message: "month is required (YYYY-MM)." });
    }

    const publishState = await getPublishState(month);
    return response(event, 200, {
      status: publishState.status,
      publishedAt: publishState.publishedAt
    });
  }

  if (route.endsWith("/publish") && event.httpMethod === "POST") {
    if (!isManager) {
      return response(event, 403, { message: "店長のみ操作できます。" });
    }
    try {
      const body = parseJsonBody(event);
      if (body === null) {
        return response(event, 400, { message: "Invalid JSON body." });
      }

      const { month } = body;

      if (!isValidMonth(month)) {
        return response(event, 400, { message: "month is required (YYYY-MM)." });
      }

      const publishedAt = new Date().toISOString();
      const item: PublishItem = {
        pk: month,
        sk: "PUBLISH",
        status: "published",
        publishedAt,
        publishedBy: userId,
        expiresAt: computeExpiresAt(month)
      };

      await docClient.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: item
        })
      );

      return response(event, 200, { status: "published", publishedAt });
    } catch (err) {
      console.error("publish POST error:", err);
      return response(event, 500, { message: "Internal Server Error", error: String(err) });
    }
  }

  return response(event, 405, { message: "Method not allowed." });
};
