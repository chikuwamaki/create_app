import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand
} from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = process.env.TABLE_NAME;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

type SubmissionItem = {
  pk: string;
  sk: string;
  userId: string;
  name: string;
  rolePreference: string;
  slotsByDate: Record<string, string[]>;
  updatedAt: string;
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
};

type PublishItem = {
  pk: string;
  sk: string;
  status: "draft" | "published";
  publishedAt?: string;
  publishedBy?: string;
};

function response(statusCode: number, body: object) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

function getClaims(event: any): Record<string, string> {
  return event?.requestContext?.authorizer?.claims ?? {};
}

function getRoute(event: any): string {
  return event?.resource ?? event?.path ?? "";
}

function getRole(claims: Record<string, string>): string | undefined {
  return claims["custom:role"] ?? claims.role;
}

function isValidMonth(month: string | undefined): boolean {
  return typeof month === "string" && /^\d{4}-\d{2}$/.test(month);
}

function mapItem(item: SubmissionItem) {
  return {
    userId: item.userId,
    name: item.name,
    rolePreference: item.rolePreference,
    slotsByDate: item.slotsByDate || {}
  };
}

function chunkRequests<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
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
    return response(200, { ok: true });
  }

  if (!TABLE_NAME) {
    return response(500, { message: "TABLE_NAME is not configured." });
  }

  const claims = getClaims(event);
  const userId = claims.sub;
  const name = claims.name || claims.email || "スタッフ";
  const role = getRole(claims);
  const route = getRoute(event);

  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }

  if (route.endsWith("/availability") && event.httpMethod === "GET") {
    const month = event.queryStringParameters?.month;
    const scope = event.queryStringParameters?.scope;

    if (!isValidMonth(month)) {
      return response(400, { message: "month is required (YYYY-MM)." });
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
      return response(200, { items: item ? [mapItem(item)] : [] });
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
    return response(200, { items });
  }

  if (route.endsWith("/availability") && event.httpMethod === "POST") {
    let body: any = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { message: "Invalid JSON body." });
    }

    const { month, rolePreference, slotsByDate } = body;

    if (!isValidMonth(month)) {
      return response(400, { message: "month is required (YYYY-MM)." });
    }

    if (!rolePreference || !["ホール", "キッチン", "どちらでも"].includes(rolePreference)) {
      return response(400, { message: "rolePreference is invalid." });
    }

    const item: SubmissionItem = {
      pk: month,
      sk: `SUBMISSION#${userId}`,
      userId,
      name,
      rolePreference,
      slotsByDate: slotsByDate || {},
      updatedAt: new Date().toISOString()
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      })
    );

    return response(200, { item: mapItem(item) });
  }

  if (route.endsWith("/assignments") && event.httpMethod === "GET") {
    const month = event.queryStringParameters?.month;

    if (!isValidMonth(month)) {
      return response(400, { message: "month is required (YYYY-MM)." });
    }

    const publishState = await getPublishState(month);
    if (publishState.status !== "published" && role !== "manager") {
      return response(403, { message: "まだ公開されていません。" });
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

    return response(200, { status: publishState.status, items });
  }

  if (route.endsWith("/assignments") && event.httpMethod === "POST") {
    if (role !== "manager") {
      return response(403, { message: "店長のみ操作できます。" });
    }

    let body: any = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { message: "Invalid JSON body." });
    }

    const { month, assignments } = body;

    if (!isValidMonth(month)) {
      return response(400, { message: "month is required (YYYY-MM)." });
    }

    const publishState = await getPublishState(month);
    if (publishState.status === "published") {
      return response(409, { message: "公開済みのため変更できません。" });
    }

    if (!Array.isArray(assignments)) {
      return response(400, { message: "assignments is required." });
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

      const item: AssignmentItem = {
        pk: month,
        sk: `ASSIGNMENT#${date}#${roleValue}#${time}`,
        date,
        time,
        role: roleValue,
        staffId,
        staffName,
        updatedAt: new Date().toISOString()
      };

      return {
        PutRequest: {
          Item: item
        }
      };
    });

    if (putRequests.some((request: any) => request === null)) {
      return response(400, { message: "assignments format is invalid." });
    }

    const allRequests = [...deleteRequests, ...putRequests];
    const batches = chunkRequests(allRequests, 25);

    for (const batch of batches) {
      await docClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: batch
          }
        })
      );
    }

    return response(200, { ok: true });
  }

  if (route.endsWith("/publish") && event.httpMethod === "GET") {
    const month = event.queryStringParameters?.month;

    if (!isValidMonth(month)) {
      return response(400, { message: "month is required (YYYY-MM)." });
    }

    const publishState = await getPublishState(month);
    return response(200, {
      status: publishState.status,
      publishedAt: publishState.publishedAt
    });
  }

  if (route.endsWith("/publish") && event.httpMethod === "POST") {
    if (role !== "manager") {
      return response(403, { message: "店長のみ操作できます。" });
    }

    let body: any = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { message: "Invalid JSON body." });
    }

    const { month } = body;

    if (!isValidMonth(month)) {
      return response(400, { message: "month is required (YYYY-MM)." });
    }

    const publishState = await getPublishState(month);
    if (publishState.status === "published") {
      return response(200, {
        status: publishState.status,
        publishedAt: publishState.publishedAt
      });
    }

    const publishedAt = new Date().toISOString();
    const item: PublishItem = {
      pk: month,
      sk: "PUBLISH",
      status: "published",
      publishedAt,
      publishedBy: userId
    };

    await docClient.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      })
    );

    return response(200, { status: "published", publishedAt });
  }

  return response(405, { message: "Method not allowed." });
};
