#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ShiftAppInfraStack } from "../lib/shift-app-infra-stack";

const app = new cdk.App();

const userPoolId = app.node.tryGetContext("userPoolId") as string | undefined;
const allowedOrigin = app.node.tryGetContext("allowedOrigin") as string | undefined;
const budgetAlertEmail = app.node.tryGetContext("budgetAlertEmail") as
  | string
  | undefined;
const budgetLimitUsd = Number(app.node.tryGetContext("budgetLimitUsd") ?? "1");
const budgetAlertThresholdUsd = Number(
  app.node.tryGetContext("budgetAlertThresholdUsd") ?? "0.01"
);
const budgetShutdownThresholdUsd = Number(
  app.node.tryGetContext("budgetShutdownThresholdUsd") ?? "1"
);
const stopApiLambda =
  (app.node.tryGetContext("stopApiLambda") ?? "true") === "true";
const wafRateLimit = Number(app.node.tryGetContext("wafRateLimit") ?? "1000");
const apiThrottleRate = Number(
  app.node.tryGetContext("apiThrottleRate") ?? "20"
);
const apiThrottleBurst = Number(
  app.node.tryGetContext("apiThrottleBurst") ?? "40"
);
const adminGroupName = app.node.tryGetContext("adminGroupName") as
  | string
  | undefined;
const adminAllowedOrigin = app.node.tryGetContext("adminAllowedOrigin") as
  | string
  | undefined;

if (!userPoolId) {
  throw new Error("Context userPoolId is required.");
}

if (!budgetAlertEmail) {
  throw new Error("Context budgetAlertEmail is required.");
}

new ShiftAppInfraStack(app, "ShiftAppInfraStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-northeast-1"
  },
  userPoolId,
  allowedOrigin,
  adminAllowedOrigin,
  adminGroupName,
  budgetAlertEmail,
  budgetLimitUsd,
  budgetAlertThresholdUsd,
  budgetShutdownThresholdUsd,
  stopApiLambda,
  wafRateLimit,
  apiThrottleRate,
  apiThrottleBurst
});
