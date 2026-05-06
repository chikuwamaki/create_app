import * as path from "path";
import * as cdk from "aws-cdk-lib";
import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import { Construct } from "constructs";

type ShiftAppInfraStackProps = StackProps & {
  userPoolId: string;
  allowedOrigin?: string;
};

export class ShiftAppInfraStack extends Stack {
  constructor(scope: Construct, id: string, props: ShiftAppInfraStackProps) {
    super(scope, id, props);

    const allowedOrigin = props.allowedOrigin ?? "http://localhost:5173";

    const table = new dynamodb.Table(this, "ShiftSubmissions", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    const handler = new lambdaNodejs.NodejsFunction(
      this,
      "ShiftSubmissionHandler",
      {
        runtime: lambda.Runtime.NODEJS_18_X,
        entry: path.join(__dirname, "../lambda/shift-submissions.ts"),
        handler: "handler",
        environment: {
          TABLE_NAME: table.tableName,
          CORS_ORIGIN: allowedOrigin
        }
      }
    );

    table.grantReadWriteData(handler);

    const userPool = cognito.UserPool.fromUserPoolId(
      this,
      "UserPool",
      props.userPoolId
    );

    const authorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      { cognitoUserPools: [userPool] }
    );

    const api = new apigateway.RestApi(this, "ShiftApi", {
      defaultCorsPreflightOptions: {
        allowOrigins: [allowedOrigin],
        allowMethods: ["GET", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"]
      }
    });

    const gatewayResponseHeaders = {
      "Access-Control-Allow-Origin": `'${allowedOrigin}'`,
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

    new cdk.CfnOutput(this, "ApiUrl", { value: api.url });
    new cdk.CfnOutput(this, "TableName", { value: table.tableName });
  }
}
