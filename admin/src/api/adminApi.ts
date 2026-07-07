export type SubmissionRole = "ホール" | "キッチン" | "どちらでも";
export type AssignmentRole = "ホール" | "キッチン";

export type AdminSubmission = {
  userId: string;
  name: string;
  rolePreference: SubmissionRole;
  slotsByDate: Record<string, string[]>;
  updatedAt?: string;
  expiresAt?: number;
};

export type AdminAssignment = {
  date: string;
  time: string;
  role: AssignmentRole;
  staffId: string;
  staffName: string;
  updatedAt?: string;
  expiresAt?: number;
};

export type AdminPublish = {
  status: "draft" | "published";
  publishedAt?: string;
  publishedBy?: string;
  expiresAt?: number;
};

export type AdminUser = {
  username?: string;
  userId?: string;
  enabled: boolean;
  status?: string;
  email?: string;
  name?: string;
  role?: string;
  groups: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type AdminDataSummary = {
  month: string;
  total: number;
  submissions: number;
  assignments: number;
  publishStates: number;
  other: number;
  deleted?: number;
};

export type AdminCostService = {
  service: string;
  amountUsd: number;
};

export type AdminRealtimeCostService = AdminCostService & {
  usage: number;
  unit: string;
  detail: string;
};

export type AdminRealtimeCostEstimate = {
  source: "CloudWatch";
  periodStart: string;
  periodEnd: string;
  elapsedHours: number;
  monthHours: number;
  estimatedUsd: number;
  projectedUsd: number;
  services: AdminRealtimeCostService[];
  pricing: {
    currency: "USD";
    usdToJpy: number;
    label: string;
  };
  wafEnabled?: boolean;
  note?: string;
};

export type AdminCostSummary = {
  currency: "USD";
  periodStart: string;
  periodEndExclusive: string;
  elapsedDays: number;
  daysInMonth: number;
  actualUsd: number;
  projectedUsd: number;
  services: AdminCostService[];
  realtimeEstimate?: AdminRealtimeCostEstimate;
  updatedAt: string;
  note?: string;
};

export type AdminAgentResponse = {
  answer: string;
  source: "gemini";
  model: string;
  anonymized: boolean;
  totals: {
    staff: number;
    submissions: number;
    assignments: number;
    slots: number;
    noSubmissionDates?: number;
  };
};

export type AdminGeneratedAssignmentSummary = {
  staffId: string;
  staffName: string;
  assignedCount: number;
  submittedCount: number;
};

export type AdminGeneratedShortage = {
  date: string;
  time: string;
  requiredCount: number;
  assignedCount: number;
  shortageCount: number;
  availableCount: number;
};

export type AdminGenerateAssignmentsResponse = {
  month: string;
  assignments: AdminAssignment[];
  shortages: AdminGeneratedShortage[];
  staffLoads: AdminGeneratedAssignmentSummary[];
  explanation: string;
  generatedAt: string;
  rules: {
    minStaffPerSlot: number;
    staffingRules?: StaffingRules;
    roles: string[];
    source: string;
    strategy: string;
  };
};

export type StaffingRules = {
  defaultStaffPerSlot: number;
  weekdayStaffPerSlot: number;
  weekendStaffPerSlot: number;
  dateOverrides: Record<string, number>;
};

function requireEnv(name: string): string {
  const value = import.meta.env[name] as string | undefined;
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定です。`);
  }
  return value;
}

function buildUrl(path: string): URL {
  const base = requireEnv("VITE_API_BASE_URL");
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

async function parseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

async function getJson<T>(url: URL, token: string): Promise<T> {
  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const data = await parseJson<T & { message?: string }>(response);
  if (!response.ok) {
    throw new Error((data as any).message ?? "リクエストに失敗しました。");
  }
  return data as T;
}

async function postJson<T>(url: URL, token: string, body: unknown): Promise<T> {
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body)
  });

  const data = await parseJson<T & { message?: string }>(response);
  if (!response.ok) {
    throw new Error((data as any).message ?? "リクエストに失敗しました。");
  }
  return data as T;
}

export async function fetchAdminSubmissions(params: {
  month: string;
  token: string;
  userId?: string;
  name?: string;
  rolePreference?: string;
  date?: string;
}): Promise<AdminSubmission[]> {
  const url = buildUrl("admin/availability");
  url.searchParams.set("month", params.month);
  if (params.userId) {
    url.searchParams.set("userId", params.userId);
  }
  if (params.name) {
    url.searchParams.set("name", params.name);
  }
  if (params.rolePreference) {
    url.searchParams.set("rolePreference", params.rolePreference);
  }
  if (params.date) {
    url.searchParams.set("date", params.date);
  }

  const data = await getJson<{ items?: AdminSubmission[] }>(url, params.token);
  return data.items ?? [];
}

export async function upsertAdminSubmission(params: {
  month: string;
  token: string;
  item: AdminSubmission;
}): Promise<AdminSubmission> {
  const url = buildUrl("admin/availability");
  const data = await postJson<{ item: AdminSubmission }>(url, params.token, {
    action: "upsert",
    month: params.month,
    item: params.item
  });
  return data.item;
}

export async function bulkUpsertAdminSubmissions(params: {
  month: string;
  token: string;
  items: AdminSubmission[];
}): Promise<void> {
  const url = buildUrl("admin/availability");
  await postJson(url, params.token, {
    action: "bulkUpsert",
    month: params.month,
    items: params.items
  });
}

export async function deleteAdminSubmission(params: {
  month: string;
  token: string;
  userId: string;
}): Promise<void> {
  const url = buildUrl("admin/availability");
  await postJson(url, params.token, {
    action: "delete",
    month: params.month,
    userId: params.userId
  });
}

export async function bulkDeleteAdminSubmissions(params: {
  month: string;
  token: string;
  userIds: string[];
}): Promise<void> {
  const url = buildUrl("admin/availability");
  await postJson(url, params.token, {
    action: "bulkDelete",
    month: params.month,
    userIds: params.userIds
  });
}

export async function fetchAdminAssignments(params: {
  month: string;
  token: string;
  date?: string;
  role?: string;
  staffId?: string;
}): Promise<AdminAssignment[]> {
  const url = buildUrl("admin/assignments");
  url.searchParams.set("month", params.month);
  if (params.date) {
    url.searchParams.set("date", params.date);
  }
  if (params.role) {
    url.searchParams.set("role", params.role);
  }
  if (params.staffId) {
    url.searchParams.set("staffId", params.staffId);
  }

  const data = await getJson<{ items?: AdminAssignment[] }>(url, params.token);
  return data.items ?? [];
}

export async function replaceAdminAssignments(params: {
  month: string;
  token: string;
  assignments: AdminAssignment[];
}): Promise<void> {
  const url = buildUrl("admin/assignments");
  await postJson(url, params.token, {
    action: "replace",
    month: params.month,
    assignments: params.assignments
  });
}

export async function upsertAdminAssignments(params: {
  month: string;
  token: string;
  assignments: AdminAssignment[];
}): Promise<void> {
  const url = buildUrl("admin/assignments");
  await postJson(url, params.token, {
    action: "upsert",
    month: params.month,
    assignments: params.assignments
  });
}

export async function generateAdminAssignments(params: {
  month: string;
  token: string;
  minStaffPerSlot: number;
  staffingRules: StaffingRules;
  roles: AssignmentRole[];
}): Promise<AdminGenerateAssignmentsResponse> {
  const url = buildUrl("admin/assignments/generate");
  return await postJson<AdminGenerateAssignmentsResponse>(url, params.token, {
    month: params.month,
    minStaffPerSlot: params.minStaffPerSlot,
    staffingRules: params.staffingRules,
    roles: params.roles
  });
}

export async function deleteAdminAssignments(params: {
  month: string;
  token: string;
  keys: Array<Pick<AdminAssignment, "date" | "time" | "role" | "staffId">>;
}): Promise<void> {
  const url = buildUrl("admin/assignments");
  await postJson(url, params.token, {
    action: "bulkDelete",
    month: params.month,
    keys: params.keys
  });
}

export async function fetchAdminPublish(params: {
  month: string;
  token: string;
}): Promise<AdminPublish> {
  const url = buildUrl("admin/publish");
  url.searchParams.set("month", params.month);
  return await getJson<AdminPublish>(url, params.token);
}

export async function setAdminPublishState(params: {
  month: string;
  token: string;
  status: "draft" | "published";
}): Promise<AdminPublish> {
  const url = buildUrl("admin/publish");
  return await postJson<AdminPublish>(url, params.token, {
    action: "set",
    month: params.month,
    status: params.status
  });
}

export async function deleteAdminPublishState(params: {
  month: string;
  token: string;
}): Promise<void> {
  const url = buildUrl("admin/publish");
  await postJson(url, params.token, {
    action: "delete",
    month: params.month
  });
}

export async function fetchAdminUsers(params: {
  token: string;
  query?: string;
  limit?: number;
  paginationToken?: string;
}): Promise<{ users: AdminUser[]; nextToken?: string }> {
  const url = buildUrl("admin/users");
  if (params.query) {
    url.searchParams.set("query", params.query);
  }
  if (params.limit) {
    url.searchParams.set("limit", `${params.limit}`);
  }
  if (params.paginationToken) {
    url.searchParams.set("paginationToken", params.paginationToken);
  }

  return await getJson<{ users: AdminUser[]; nextToken?: string }>(
    url,
    params.token
  );
}

export async function updateAdminUser(params: {
  token: string;
  username: string;
  role?: "staff" | "manager";
  isAdmin?: boolean;
}): Promise<void> {
  const url = buildUrl("admin/users");
  await postJson(url, params.token, {
    username: params.username,
    role: params.role,
    isAdmin: params.isAdmin
  });
}

export async function fetchAdminCost(params: {
  token: string;
}): Promise<AdminCostSummary> {
  const url = buildUrl("admin/cost");
  return await getJson<AdminCostSummary>(url, params.token);
}

export async function askAdminAgent(params: {
  token: string;
  month: string;
  question: string;
  minStaffPerSlot: number;
}): Promise<AdminAgentResponse> {
  const url = buildUrl("admin/agent");
  return await postJson<AdminAgentResponse>(url, params.token, {
    month: params.month,
    question: params.question,
    minStaffPerSlot: params.minStaffPerSlot
  });
}

export async function backfillTtl(params: {
  token: string;
  months?: string[];
}): Promise<{ ok: boolean; months?: string[] }> {
  const url = buildUrl("admin/ttl");
  return await postJson<{ ok: boolean; months?: string[] }>(url, params.token, {
    action: "backfill",
    months: params.months
  });
}

export async function purgeOldData(params: {
  token: string;
  cutoffMonth: string;
}): Promise<{ ok: boolean; deleted?: number }> {
  const url = buildUrl("admin/ttl");
  return await postJson<{ ok: boolean; deleted?: number }>(url, params.token, {
    action: "purge",
    cutoffMonth: params.cutoffMonth
  });
}

export async function fetchDataSummary(params: {
  token: string;
  month: string;
}): Promise<AdminDataSummary> {
  const url = buildUrl("admin/ttl");
  return await postJson<AdminDataSummary>(url, params.token, {
    action: "summary",
    month: params.month
  });
}

export async function deleteMonthData(params: {
  token: string;
  month: string;
}): Promise<AdminDataSummary> {
  const url = buildUrl("admin/ttl");
  return await postJson<AdminDataSummary>(url, params.token, {
    action: "deleteMonth",
    month: params.month
  });
}
