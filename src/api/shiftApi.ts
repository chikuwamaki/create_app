export type SubmissionRole = "ホール" | "キッチン" | "どちらでも";
export type AssignmentRole = "ホール" | "キッチン";

export type Submission = {
  userId: string;
  name: string;
  rolePreference: SubmissionRole;
  slotsByDate: Record<string, string[]>;
};

export type Assignment = {
  date: string;
  time: string;
  role: AssignmentRole;
  staffId: string;
  staffName: string;
};

export type PublishState = {
  status: "draft" | "published";
  publishedAt?: string;
};

export type SubmitPayload = {
  month: string;
  rolePreference: SubmissionRole;
  slotsByDate: Record<string, string[]>;
};

export type AssignmentsPayload = {
  month: string;
  assignments: Assignment[];
};

export type StaffingRules = {
  defaultStaffPerSlot: number;
  weekdayStaffPerSlot: number;
  weekendStaffPerSlot: number;
  dateOverrides: Record<string, number>;
};

export type GeneratedShortage = {
  date: string;
  time: string;
  requiredCount: number;
  assignedCount: number;
  shortageCount: number;
  availableCount: number;
};

export type GeneratedStaffLoad = {
  staffId: string;
  staffName: string;
  assignedCount: number;
  submittedCount: number;
};

export type GenerateAssignmentsResult = {
  month: string;
  assignments: Assignment[];
  shortages: GeneratedShortage[];
  staffLoads: GeneratedStaffLoad[];
  explanation: string;
  generatedAt: string;
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

export async function fetchSubmissions(params: {
  month: string;
  token: string;
  scope?: "self" | "all";
}): Promise<Submission[]> {
  const url = buildUrl("availability");
  url.searchParams.set("month", params.month);
  if (params.scope === "self") {
    url.searchParams.set("scope", "self");
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${params.token}`
    }
  });

  const data = await parseJson<{ items?: Submission[]; message?: string }>(
    response
  );

  if (!response.ok) {
    throw new Error(data.message ?? "提出データの取得に失敗しました。");
  }

  return data.items ?? [];
}

export async function submitAvailability(params: {
  payload: SubmitPayload;
  token: string;
}): Promise<Submission> {
  const url = buildUrl("availability");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.token}`
    },
    body: JSON.stringify(params.payload)
  });

  const data = await parseJson<{ item?: Submission; message?: string }>(
    response
  );

  if (!response.ok) {
    throw new Error(data.message ?? "提出の保存に失敗しました。");
  }

  if (!data.item) {
    throw new Error("提出の保存結果が不正です。");
  }

  return data.item;
}

export async function fetchAssignments(params: {
  month: string;
  token: string;
}): Promise<{ status: PublishState["status"]; items: Assignment[] }> {
  const url = buildUrl("assignments");
  url.searchParams.set("month", params.month);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${params.token}`
    }
  });

  const data = await parseJson<
    { items?: Assignment[]; status?: PublishState["status"]; message?: string }
  >(response);

  if (!response.ok) {
    throw new Error(data.message ?? "シフトの取得に失敗しました。");
  }

  return {
    status: data.status ?? "draft",
    items: data.items ?? []
  };
}

export async function saveAssignments(params: {
  payload: AssignmentsPayload;
  token: string;
}): Promise<void> {
  const url = buildUrl("assignments");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.token}`
    },
    body: JSON.stringify(params.payload)
  });

  const data = await parseJson<{ message?: string }>(response);

  if (!response.ok) {
    throw new Error(data.message ?? "シフトの保存に失敗しました。");
  }
}

export async function generateAssignments(params: {
  month: string;
  token: string;
  minStaffPerSlot: number;
  staffingRules: StaffingRules;
  roles: AssignmentRole[];
}): Promise<GenerateAssignmentsResult> {
  const url = buildUrl("assignments/generate");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.token}`
    },
    body: JSON.stringify({
      month: params.month,
      minStaffPerSlot: params.minStaffPerSlot,
      staffingRules: params.staffingRules,
      roles: params.roles
    })
  });

  const data = await parseJson<GenerateAssignmentsResult & { message?: string }>(
    response
  );

  if (!response.ok) {
    throw new Error(data.message ?? "シフト自動作成に失敗しました。");
  }

  return data;
}

export async function fetchPublishState(params: {
  month: string;
  token: string;
}): Promise<PublishState> {
  const url = buildUrl("publish");
  url.searchParams.set("month", params.month);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${params.token}`
    }
  });

  const data = await parseJson<
    { status?: PublishState["status"]; publishedAt?: string; message?: string }
  >(response);

  if (!response.ok) {
    throw new Error(data.message ?? "公開状態の取得に失敗しました。");
  }

  return {
    status: data.status ?? "draft",
    publishedAt: data.publishedAt
  };
}

export async function publishAssignments(params: {
  month: string;
  token: string;
}): Promise<PublishState> {
  const url = buildUrl("publish");
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.token}`
    },
    body: JSON.stringify({ month: params.month })
  });

  const data = await parseJson<
    { status?: PublishState["status"]; publishedAt?: string; message?: string }
  >(response);

  if (!response.ok) {
    throw new Error(data.message ?? "公開に失敗しました。");
  }

  return {
    status: data.status ?? "draft",
    publishedAt: data.publishedAt
  };
}
