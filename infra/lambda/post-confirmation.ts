import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand
} from "@aws-sdk/client-cognito-identity-provider";

type CognitoEvent = {
  userPoolId: string;
  userName: string;
  request: {
    userAttributes?: Record<string, string>;
  };
};

const client = new CognitoIdentityProviderClient({});

export const handler = async (event: CognitoEvent) => {
  const attributes = event.request?.userAttributes ?? {};
  const role = attributes["custom:role"];

  if (!role) {
    await client.send(
      new AdminUpdateUserAttributesCommand({
        UserPoolId: event.userPoolId,
        Username: event.userName,
        UserAttributes: [{ Name: "custom:role", Value: "staff" }]
      })
    );
  }

  return event;
};
