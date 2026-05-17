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
