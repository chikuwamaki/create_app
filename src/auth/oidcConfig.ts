import { WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts";

function resolveAuthority(): string {
  const raw =
    (import.meta.env.VITE_COGNITO_AUTHORITY as string | undefined) ??
    (import.meta.env.VITE_COGNITO_DOMAIN as string | undefined);

  if (!raw) {
    throw new Error("CognitoのAuthority設定がありません。envを確認してください。");
  }

  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function resolveHostedDomain(): string {
  const raw = import.meta.env.VITE_COGNITO_DOMAIN as string | undefined;
  if (!raw) {
    throw new Error("Cognitoのドメイン設定がありません。envを確認してください。");
  }
  const normalized = raw.startsWith("http") ? raw : `https://${raw}`;
  const url = new URL(normalized);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function requireEnv(name: string): string {
  const value = import.meta.env[name] as string | undefined;
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定です。`);
  }
  return value;
}

function normalizeRootUri(value: string): string {
  const url = new URL(value);
  if (url.pathname === "/") {
    url.pathname = "";
  }
  return url.toString().replace(/\/$/, "");
}

export const oidcConfig: UserManagerSettings = {
  authority: resolveAuthority(),
  client_id: requireEnv("VITE_COGNITO_CLIENT_ID"),
  redirect_uri: requireEnv("VITE_COGNITO_REDIRECT_URI"),
  post_logout_redirect_uri: normalizeRootUri(requireEnv("VITE_COGNITO_LOGOUT_URI")),
  response_type: "code",
  scope:
    (import.meta.env.VITE_COGNITO_SCOPES as string | undefined) ??
    "openid email phone",
  userStore: new WebStorageStateStore({ store: window.localStorage })
};

function resolveScopes(): string {
  return (
    (import.meta.env.VITE_COGNITO_SCOPES as string | undefined) ??
    "openid email phone"
  );
}

export function buildSignupUrl(): string {
  const clientId = requireEnv("VITE_COGNITO_CLIENT_ID");
  const redirectUri = requireEnv("VITE_COGNITO_REDIRECT_URI");
  const domain = resolveHostedDomain();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: resolveScopes()
  });
  const url = new URL("/signup", domain);
  url.search = params.toString();
  return url.toString();
}

export function buildLogoutUrl(): string {
  const clientId = requireEnv("VITE_COGNITO_CLIENT_ID");
  const logoutUri = normalizeRootUri(requireEnv("VITE_COGNITO_LOGOUT_URI"));
  const domain = resolveHostedDomain();
  const params = new URLSearchParams({
    client_id: clientId,
    logout_uri: logoutUri
  });
  const url = new URL("/logout", domain);
  url.search = params.toString();
  return url.toString();
}
