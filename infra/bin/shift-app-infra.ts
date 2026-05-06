#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { ShiftAppInfraStack } from "../lib/shift-app-infra-stack";

const app = new cdk.App();

const userPoolId = app.node.tryGetContext("userPoolId") as string | undefined;
const allowedOrigin = app.node.tryGetContext("allowedOrigin") as string | undefined;

if (!userPoolId) {
  throw new Error("Context userPoolId is required.");
}

new ShiftAppInfraStack(app, "ShiftAppInfraStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "ap-northeast-1"
  },
  userPoolId,
  allowedOrigin
});
