/**
 * Authenticating as the GitHub App.
 *
 * Two steps, and the distinction between them is the whole security story. The
 * App's private key signs a short JWT that proves which app is calling; that
 * JWT can then be exchanged for an installation token, which is scoped to one
 * installation and expires in an hour. Only the second ever touches a
 * consumer's repository.
 *
 * The private key never leaves this process and is never sent anywhere. What
 * goes over the wire is a signature over a payload that says nothing except
 * which app is asking and for how long.
 *
 * Nothing here decides what the token may do. That was decided when the
 * consumer chose which repositories to install on, and it is enforced by GitHub
 * rather than by us, which is the reason the App exists at all instead of a
 * personal token with access to everything its owner can see.
 */
import { createSign } from "node:crypto";
import { apiFromFetch, DeliveryError, type GitHubApi } from "./deliver.ts";

/** How long an app JWT is valid. GitHub refuses anything over ten minutes. */
const JWT_TTL_SECONDS = 540;

/** Refresh an installation token this long before it actually expires. */
const RENEW_BEFORE_MS = 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface AppCredentials {
  /** The numeric App id, from the app's settings page. */
  appId: string;
  /** The RSA private key, in PEM form. Never logged, never sent. */
  privateKey: string;
}

/**
 * Signs a JWT proving this is the app.
 *
 * Backdated by a minute because GitHub rejects a token whose `iat` is in the
 * future, and a clock a few seconds fast is ordinary rather than exceptional.
 */
export function appJwt(credentials: AppCredentials, now = Date.now()): string {
  const issued = Math.floor(now / 1000) - 60;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: issued,
      exp: issued + JWT_TTL_SECONDS,
      iss: credentials.appId,
    }),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  return `${header}.${payload}.${base64url(signer.sign(credentials.privateKey))}`;
}

export interface InstallationToken {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  token: string;
  expires_at: string;
}

/**
 * Exchanges the app JWT for a token scoped to one installation.
 *
 * `repositories` narrows it further, to the repositories this migration is
 * actually for. An installation may cover more than one, and a token that can
 * reach every repository a consumer connected is a token that does not need to
 * be able to.
 */
export async function installationToken(
  credentials: AppCredentials,
  installationId: number,
  options: { repositories?: readonly string[]; fetchImpl?: typeof fetch } = {},
): Promise<InstallationToken> {
  const api = apiFromFetch(appJwt(credentials), options.fetchImpl ?? fetch);

  const response = await api.request<TokenResponse>(
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    options.repositories && options.repositories.length > 0
      ? { repositories: [...options.repositories] }
      : undefined,
  );

  return {
    token: response.data.token,
    expiresAt: Date.parse(response.data.expires_at),
  };
}

/**
 * A client that mints and renews its own installation token.
 *
 * Migrations take minutes rather than seconds, so a token fetched at the start
 * can expire partway through and leave a branch pushed and no pull request
 * opened. Renewing a minute early costs one extra request an hour and removes
 * that failure entirely.
 */
export function appApi(
  credentials: AppCredentials,
  installationId: number,
  options: { repositories?: readonly string[]; fetchImpl?: typeof fetch } = {},
): GitHubApi {
  let current: InstallationToken | undefined;

  const fresh = async (): Promise<string> => {
    if (current && current.expiresAt - Date.now() > RENEW_BEFORE_MS) {
      return current.token;
    }
    current = await installationToken(credentials, installationId, options);
    return current.token;
  };

  return {
    async request<T>(method: string, path: string, body?: Record<string, unknown>) {
      const token = await fresh();
      return apiFromFetch(token, options.fetchImpl ?? fetch).request<T>(
        method,
        path,
        body,
      );
    },
  };
}

/**
 * The App's manifest: what it asks for, and what it refuses to ask for.
 *
 * Written down here rather than clicked through a form, so that the permissions
 * a consumer is asked to grant are reviewable in the repository and cannot
 * quietly widen. `default_permissions` is the whole of it: no `workflows`, no
 * `actions`, no `administration`, no organisation scope. See
 * `REFUSED_PERMISSIONS` in `link.ts` for why each of those is refused.
 */
export function appManifest(options: {
  name: string;
  url: string;
  redirectUrl: string;
  webhookUrl?: string;
}): Record<string, unknown> {
  return {
    name: options.name,
    url: options.url,
    redirect_url: options.redirectUrl,
    public: false,
    default_permissions: {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      checks: "read",
    },
    default_events: [
      "installation",
      "installation_repositories",
      "check_suite",
      "pull_request",
    ],
    ...(options.webhookUrl
      ? { hook_attributes: { url: options.webhookUrl, active: true } }
      : { hook_attributes: { active: false } }),
  };
}

export interface ConvertedApp {
  id: number;
  slug: string;
  name: string;
  pem: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
}

interface ConversionResponse {
  id: number;
  slug: string;
  name: string;
  pem: string;
  webhook_secret: string | null;
  client_id: string;
  client_secret: string;
}

/**
 * Turns the one-time code from the manifest redirect into real credentials.
 *
 * The code is valid for an hour and exactly once, which is why this is the only
 * place it is used and why nothing retries it: a second attempt cannot succeed
 * and would only make the failure look like something it is not.
 */
export async function convertManifestCode(
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConvertedApp> {
  const response = await fetchImpl(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "invariant-updater",
      },
    },
  );

  const text = await response.text();
  if (!response.ok) {
    throw new DeliveryError(
      `converting the manifest code failed: ${text || response.statusText}`,
      response.status,
    );
  }

  const data = JSON.parse(text) as ConversionResponse;
  return {
    id: data.id,
    slug: data.slug,
    name: data.name,
    pem: data.pem,
    webhookSecret: data.webhook_secret ?? "",
    clientId: data.client_id,
    clientSecret: data.client_secret,
  };
}
