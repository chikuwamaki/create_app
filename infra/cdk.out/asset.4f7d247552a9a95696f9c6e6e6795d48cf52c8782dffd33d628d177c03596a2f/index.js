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
  if (!userId) {
    return response(401, { message: "Unauthorized" });
  }
  if (event.httpMethod === "GET") {
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
  if (event.httpMethod === "POST") {
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
  return response(405, { message: "Method not allowed." });
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
