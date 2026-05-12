import {
  CloudFrontClient,
  GetDistributionConfigCommand,
  UpdateDistributionCommand
} from "@aws-sdk/client-cloudfront";
import {
  LambdaClient,
  PutFunctionConcurrencyCommand
} from "@aws-sdk/client-lambda";

type BudgetEvent = {
  Records?: Array<{ Sns?: { Message?: string } }>;
};

const distributionId = process.env.DISTRIBUTION_ID;
const targetFunctions = (process.env.TARGET_FUNCTIONS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const cloudfrontClient = new CloudFrontClient({});
const lambdaClient = new LambdaClient({});

async function disableDistribution() {
  if (!distributionId) {
    return;
  }
  const configResult = await cloudfrontClient.send(
    new GetDistributionConfigCommand({ Id: distributionId })
  );
  if (!configResult.DistributionConfig || !configResult.ETag) {
    return;
  }
  if (!configResult.DistributionConfig.Enabled) {
    return;
  }
  const updatedConfig = {
    ...configResult.DistributionConfig,
    Enabled: false
  };
  await cloudfrontClient.send(
    new UpdateDistributionCommand({
      Id: distributionId,
      IfMatch: configResult.ETag,
      DistributionConfig: updatedConfig
    })
  );
}

async function disableApiLambdas() {
  await Promise.all(
    targetFunctions.map((functionName) =>
      lambdaClient.send(
        new PutFunctionConcurrencyCommand({
          FunctionName: functionName,
          ReservedConcurrentExecutions: 0
        })
      )
    )
  );
}

export const handler = async (_event: BudgetEvent) => {
  await disableDistribution();
  await disableApiLambdas();
  return { ok: true };
};
