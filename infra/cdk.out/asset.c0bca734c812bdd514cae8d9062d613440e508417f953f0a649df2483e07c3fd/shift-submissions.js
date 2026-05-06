const AWS = require("aws-sdk");

const docClient = new AWS.DynamoDB.DocumentClient();
const TABLE_NAME = process.env.TABLE_NAME;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

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
  return (
    (event.requestContext &&
      event.requestContext.authorizer &&
      event.requestContext.authorizer.claims) ||
    {}
  );
}

function isValidMonth(month) {
  return typeof month === "string" && /^\d{4}-\d{2}$/.test(month);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return response(200, { ok: true });
  }

  if (!TABLE_NAME) {
    return response(500, { message: "TABLE_NAME is not configured." });
  }

  const claims = getClaims(event);
  const userId = claims.sub;
  const name = claims.name || claims.email || "スタッフ";

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
      const result = await docClient
        .get({
          TableName: TABLE_NAME,
          Key: {
            pk: month,
            sk: `SUBMISSION#${userId}`
          }
        })
        .promise();

      const item = result.Item ? mapItem(result.Item) : null;
      return response(200, { items: item ? [item] : [] });
    }

    const result = await docClient
      .query({
        TableName: TABLE_NAME,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :sk)",
        ExpressionAttributeValues: {
          ":pk": month,
          ":sk": "SUBMISSION#"
        }
      })
      .promise();

    const items = (result.Items || []).map(mapItem);
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

    if (!rolePreference || !["ホール", "キッチン", "どちらでも"].includes(rolePreference)) {
      return response(400, { message: "rolePreference is invalid." });
    }

    const item = {
      pk: month,
      sk: `SUBMISSION#${userId}`,
      userId,
      name,
      rolePreference,
      slotsByDate: slotsByDate || {},
      updatedAt: new Date().toISOString()
    };

    await docClient
      .put({
        TableName: TABLE_NAME,
        Item: item
      })
      .promise();

    return response(200, { item: mapItem(item) });
  }

  return response(405, { message: "Method not allowed." });
};

function mapItem(item) {
  return {
    userId: item.userId,
    name: item.name,
    rolePreference: item.rolePreference,
    slotsByDate: item.slotsByDate || {}
  };
}
