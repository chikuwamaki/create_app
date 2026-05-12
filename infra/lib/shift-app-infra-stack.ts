import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as customResources from "aws-cdk-lib/custom-resources";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";

type ShiftAppInfraStackProps = StackProps & {
  userPoolId: string;
  allowedOrigin?: string;
  adminAllowedOrigin?: string;
  adminGroupName?: string;
  budgetAlertEmail: string;
  budgetLimitUsd: number;
  budgetAlertThresholdUsd: number;
  budgetShutdownThresholdUsd: number;
  stopApiLambda: boolean;
  wafRateLimit: number;
  apiThrottleRate: number;
  apiThrottleBurst: number;
};

export class ShiftAppInfraStack extends Stack {
  constructor(scope: Construct, id: string, props: ShiftAppInfraStackProps) {
    super(scope, id, props);

    const siteBucket = new s3.Bucket(this, "ShiftAppSiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const originAccessIdentity = new cloudfront.OriginAccessIdentity(
      this,
      "ShiftAppSiteOAI"
    );
    siteBucket.grantRead(originAccessIdentity);

    const distribution = new cloudfront.Distribution(
      this,
      "ShiftAppSiteDistribution",
      {
        defaultRootObject: "index.html",
        defaultBehavior: {
          origin: new origins.S3Origin(siteBucket, {
            originAccessIdentity
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
        },
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.minutes(1)
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.minutes(1)
          }
        ]
      }
    );

    new s3deploy.BucketDeployment(this, "ShiftAppSiteDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../dist"))],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"]
    });

    const adminBucket = new s3.Bucket(this, "ShiftAdminSiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const adminOriginAccessIdentity = new cloudfront.OriginAccessIdentity(
      this,
      "ShiftAdminSiteOAI"
    );
    adminBucket.grantRead(adminOriginAccessIdentity);

    const adminDistribution = new cloudfront.Distribution(
      this,
      "ShiftAdminSiteDistribution",
      {
        defaultRootObject: "index.html",
        defaultBehavior: {
          origin: new origins.S3Origin(adminBucket, {
            originAccessIdentity: adminOriginAccessIdentity
          }),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
        },
        errorResponses: [
          {
            httpStatus: 403,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.minutes(1)
          },
          {
            httpStatus: 404,
            responseHttpStatus: 200,
            responsePagePath: "/index.html",
            ttl: cdk.Duration.minutes(1)
          }
        ]
      }
    );

    new s3deploy.BucketDeployment(this, "ShiftAdminSiteDeployment", {
      sources: [s3deploy.Source.asset(path.join(__dirname, "../../dist-admin"))],
      destinationBucket: adminBucket,
      distribution: adminDistribution,
      distributionPaths: ["/*"]
    });

    const siteOrigin =
      props.allowedOrigin ?? `https://${distribution.distributionDomainName}`;
    const adminOrigin =
      props.adminAllowedOrigin ??
      `https://${adminDistribution.distributionDomainName}`;
    const allowedOrigins = Array.from(
      new Set([siteOrigin, adminOrigin].filter(Boolean))
    );
    const budgetAlertEmail = props.budgetAlertEmail;
    const budgetLimitUsd = props.budgetLimitUsd;
    const budgetAlertThresholdUsd = props.budgetAlertThresholdUsd;
    const budgetShutdownThresholdUsd = props.budgetShutdownThresholdUsd;
    const stopApiLambda = props.stopApiLambda;
    const wafRateLimit = props.wafRateLimit;
    const apiThrottleRate = props.apiThrottleRate;
    const apiThrottleBurst = props.apiThrottleBurst;
    const adminGroupName = props.adminGroupName ?? "admins";

    const table = new dynamodb.Table(this, "ShiftSubmissions", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: "expiresAt",
      removalPolicy: RemovalPolicy.DESTROY
    });

    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "UserPool",
      props.userPoolId
    );

    const handler = new lambdaNodejs.NodejsFunction(
      this,
      "ShiftSubmissionHandler",
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: path.join(__dirname, "../lambda/shift-submissions.ts"),
        handler: "handler",
        environment: {
          TABLE_NAME: table.tableName,
          CORS_ORIGINS: allowedOrigins.join(","),
          USER_POOL_ID: userPool.userPoolId,
          ADMIN_GROUP_NAME: adminGroupName
        }
      }
    );

    const shutdownTopic = new sns.Topic(this, "BudgetShutdownTopic");
    shutdownTopic.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal("budgets.amazonaws.com")],
        actions: ["SNS:Publish"],
        resources: [shutdownTopic.topicArn]
      })
    );
    const shutdownHandler = new lambdaNodejs.NodejsFunction(
      this,
      "BudgetShutdownHandler",
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: path.join(__dirname, "../lambda/budget-shutdown.ts"),
        handler: "handler",
        environment: {
          DISTRIBUTION_ID: distribution.distributionId,
          TARGET_FUNCTIONS: stopApiLambda ? handler.functionName : ""
        }
      }
    );

    shutdownHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudfront:GetDistributionConfig",
          "cloudfront:UpdateDistribution"
        ],
        resources: [distribution.distributionArn]
      })
    );

    if (stopApiLambda) {
      shutdownHandler.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["lambda:PutFunctionConcurrency"],
          resources: [handler.functionArn]
        })
      );
    }

    shutdownTopic.addSubscription(
      new subscriptions.LambdaSubscription(shutdownHandler)
    );

    table.grantReadWriteData(handler);

    new cognito.CfnUserPoolGroup(this, "AdminUserPoolGroup", {
      userPoolId: userPool.userPoolId,
      groupName: adminGroupName,
      description: "Admin access group"
    });

    const postConfirmationHandler = new lambdaNodejs.NodejsFunction(
      this,
      "PostConfirmationHandler",
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: path.join(__dirname, "../lambda/post-confirmation.ts"),
        handler: "handler"
      }
    );

    postConfirmationHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["cognito-idp:AdminUpdateUserAttributes"],
        resources: [userPool.userPoolArn]
      })
    );

    postConfirmationHandler.addPermission("CognitoPostConfirmationInvoke", {
      principal: new iam.ServicePrincipal("cognito-idp.amazonaws.com"),
      sourceArn: userPool.userPoolArn
    });

    new customResources.AwsCustomResource(this, "AttachPostConfirmation", {
      onCreate: {
        service: "CognitoIdentityServiceProvider",
        action: "updateUserPool",
        parameters: {
          UserPoolId: userPool.userPoolId,
          LambdaConfig: {
            PostConfirmation: postConfirmationHandler.functionArn
          },
          AutoVerifiedAttributes: ["email"],
          AttributesRequireVerificationBeforeUpdate: ["email"]
        },
        physicalResourceId: customResources.PhysicalResourceId.of(
          `PostConfirmation-${props.userPoolId}`
        )
      },
      onUpdate: {
        service: "CognitoIdentityServiceProvider",
        action: "updateUserPool",
        parameters: {
          UserPoolId: userPool.userPoolId,
          LambdaConfig: {
            PostConfirmation: postConfirmationHandler.functionArn
          },
          AutoVerifiedAttributes: ["email"],
          AttributesRequireVerificationBeforeUpdate: ["email"]
        },
        physicalResourceId: customResources.PhysicalResourceId.of(
          `PostConfirmation-${props.userPoolId}`
        )
      },
      policy: customResources.AwsCustomResourcePolicy.fromSdkCalls({
        resources: customResources.AwsCustomResourcePolicy.ANY_RESOURCE
      })
    });

    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: `${Stack.of(this).stackName}-MonthlyBudget`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: {
          amount: budgetLimitUsd,
          unit: "USD"
        }
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: budgetAlertThresholdUsd,
            thresholdType: "ABSOLUTE_VALUE"
          },
          subscribers: [
            {
              subscriptionType: "EMAIL",
              address: budgetAlertEmail
            },
            {
              subscriptionType: "SNS",
              address: shutdownTopic.topicArn
            }
          ]
        }
      ]
    });

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      { cognitoUserPools: [userPool] }
    );

    const api = new apigateway.RestApi(this, "ShiftApi", {
      defaultCorsPreflightOptions: {
        allowOrigins: allowedOrigins,
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"]
      },
      deployOptions: {
        throttlingRateLimit: apiThrottleRate,
        throttlingBurstLimit: apiThrottleBurst
      }
    });

    const webAcl = new wafv2.CfnWebACL(this, "ShiftApiWebAcl", {
      defaultAction: { allow: {} },
      scope: "REGIONAL",
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: "ShiftApiWebAcl"
      },
      rules: [
        {
          name: "AWSManagedCommonRuleSet",
          priority: 0,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesCommonRuleSet"
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "AWSManagedCommonRuleSet"
          }
        },
        {
          name: "RateLimit",
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: wafRateLimit,
              aggregateKeyType: "IP"
            }
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: "RateLimit"
          }
        }
      ]
    });

    new wafv2.CfnWebACLAssociation(this, "ShiftApiWebAclAssociation", {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn
    });

    const gatewayResponseHeaders = {
      "Access-Control-Allow-Origin": "'*'",
      "Access-Control-Allow-Headers": "'Content-Type,Authorization'",
      "Access-Control-Allow-Methods": "'GET,POST,OPTIONS'"
    };

    api.addGatewayResponse("Default4xx", {
      type: apigateway.ResponseType.DEFAULT_4XX,
      responseHeaders: gatewayResponseHeaders
    });

    api.addGatewayResponse("Default5xx", {
      type: apigateway.ResponseType.DEFAULT_5XX,
      responseHeaders: gatewayResponseHeaders
    });

    const availability = api.root.addResource("availability");
    const assignments = api.root.addResource("assignments");
    const publish = api.root.addResource("publish");
    const admin = api.root.addResource("admin");
    const adminAvailability = admin.addResource("availability");
    const adminAssignments = admin.addResource("assignments");
    const adminPublish = admin.addResource("publish");
    const adminUsers = admin.addResource("users");
    const adminTtl = admin.addResource("ttl");
    const integration = new apigateway.LambdaIntegration(handler);

    availability.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    availability.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    assignments.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    assignments.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    publish.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    publish.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminAvailability.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminAvailability.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminAssignments.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminAssignments.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminPublish.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminPublish.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminUsers.addMethod("GET", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminUsers.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    adminTtl.addMethod("POST", integration, {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
    new cdk.CfnOutput(this, "SiteUrl", {
      value: `https://${distribution.distributionDomainName}`
    });
    new cdk.CfnOutput(this, "AdminSiteUrl", {
      value: `https://${adminDistribution.distributionDomainName}`
    });
  }
}
