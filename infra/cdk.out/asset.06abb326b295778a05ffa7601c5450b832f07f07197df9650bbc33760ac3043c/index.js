"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lambda/shift-submissions.ts
var shift_submissions_exports = {};
__export(shift_submissions_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(shift_submissions_exports);
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_lib_dynamodb = require("@aws-sdk/lib-dynamodb");
var TABLE_NAME = process.env.TABLE_NAME;
var CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
var client = new import_client_dynamodb.DynamoDBClient({});
var docClient = import_lib_dynamodb.DynamoDBDocumentClient.from(client);
function response(statusCode, body) {
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
function getClaims(event) {
  return event?.requestContext?.authorizer?.claims ?? {};
}
function getRoute(event) {
  return event?.resource ?? event?.path ?? "";
}
function getRole(claims) {
  return claims["custom:role"] ?? claims.role;
}
function isValidMonth(month) {
  return typeof month === "string" && /^\d{4}-\d{2}$/.test(month);
}
function mapItem(item) {
  return {
    userId: item.userId,
    name: item.name,
    rolePreference: item.rolePreference,
    slotsByDate: item.slotsByDate || {}
  };
}
function chunkRequests(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}
async function getPublishState(month) {
  const result = await docClient.send(
    new import_lib_dynamodb.GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: month,
        sk: "PUBLISH"
      }
    })
  );
  return result.Item ?? {
    pk: month,
    sk: "PUBLISH",
    status: "draft"
  };
}
var handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, { ok: true });
  }
  if (!TABLE_NAME) {
    return response(500, { message: "TABLE_NAME is not configured." });
  }
  const claims = getClaims(event);
  const userId = claims.sub;
  const name = claims.name || claims.email || "\u30B9\u30BF\u30C3\u30D5";
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
      const result2 = await docClient.send(
        new import_lib_dynamodb.GetCommand({
          TableName: TABLE_NAME,
          Key: {
            pk: month,
            sk: `SUBMISSION#${userId}`
          }
        })
      );
      const item = result2.Item;
      return response(200, { items: item ? [mapItem(item)] : [] });
    }
    const result = await docClient.send(
      new import_lib_dynamodb.QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": month,
          ":sk": "SUBMISSION#"
        }
      })
    );
    const items = (result.Items ?? []).map(
      (item) => mapItem(item)
    );
    return response(200, { items });
  }
  if (route.endsWith("/availability") && event.httpMethod === "POST") {
    let body = {};
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { message: "Invalid JSON body." });
    }
    const { month, rolePreference, slotsByDate } = body;
    if (!isValidMonth(month)) {
      return response(400, { message: "month is required (YYYY-MM)." });
    }
    if (!rolePreference || !["\u30DB\u30FC\u30EB", "\u30AD\u30C3\u30C1\u30F3", "\u3069\u3061\u3089\u3067\u3082"].includes(rolePreference)) {
      return response(400, { message: "rolePreference is invalid." });
    }
    const item = {
      pk: month,
      sk: `SUBMISSION#${userId}`,
      userId,
      name,
      rolePreference,
      slotsByDate: slotsByDate || {},
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await docClient.send(
      new import_lib_dynamodb.PutCommand({
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
      return response(403, { message: "\u307E\u3060\u516C\u958B\u3055\u308C\u3066\u3044\u307E\u305B\u3093\u3002" });
    }
    const result = await docClient.send(
      new import_lib_dynamodb.QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": month,
          ":sk": "ASSIGNMENT#"
        }
      })
    );
    const items = (result.Items ?? []).map((item) => {
      const assignment = item;
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
      return response(403, { message: "\u5E97\u9577\u306E\u307F\u64CD\u4F5C\u3067\u304D\u307E\u3059\u3002" });
    }
    let body = {};
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
      return response(409, { message: "\u516C\u958B\u6E08\u307F\u306E\u305F\u3081\u5909\u66F4\u3067\u304D\u307E\u305B\u3093\u3002" });
    }
    if (!Array.isArray(assignments)) {
      return response(400, { message: "assignments is required." });
    }
    const existing = await docClient.send(
      new import_lib_dynamodb.QueryCommand({
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
          pk: item.pk,
          sk: item.sk
        }
      }
    }));
    const putRequests = assignments.map((assignment) => {
      const date = assignment.date;
      const time = assignment.time;
      const roleValue = assignment.role;
      const staffId = assignment.staffId;
      const staffName = assignment.staffName;
      if (!date || !time || !roleValue || !staffId || !staffName) {
        return null;
      }
      const item = {
        pk: month,
        sk: `ASSIGNMENT#${date}#${roleValue}#${time}`,
        date,
        time,
        role: roleValue,
        staffId,
        staffName,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      return {
        PutRequest: {
          Item: item
        }
      };
    });
    if (putRequests.some((request) => request === null)) {
      return response(400, { message: "assignments format is invalid." });
    }
    const allRequests = [...deleteRequests, ...putRequests];
    const batches = chunkRequests(allRequests, 25);
    for (const batch of batches) {
      await docClient.send(
        new import_lib_dynamodb.BatchWriteCommand({
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
      return response(403, { message: "\u5E97\u9577\u306E\u307F\u64CD\u4F5C\u3067\u304D\u307E\u3059\u3002" });
    }
    let body = {};
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
    const publishedAt = (/* @__PURE__ */ new Date()).toISOString();
    const item = {
      pk: month,
      sk: "PUBLISH",
      status: "published",
      publishedAt,
      publishedBy: userId
    };
    await docClient.send(
      new import_lib_dynamodb.PutCommand({
        TableName: TABLE_NAME,
        Item: item
      })
    );
    return response(200, { status: "published", publishedAt });
  }
  return response(405, { message: "Method not allowed." });
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
