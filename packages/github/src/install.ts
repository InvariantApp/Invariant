/**
 * Proving who installed the app, on the page GitHub sends them to afterwards.
 *
 * That page's address carries an installation id, and anyone can type any
 * number into an address. Bound to a sponsored link on trust, it would let
 * someone attach a stranger's repositories to their own account with a
 * provider. So the app asks the person to authorize it as themselves while
 * installing, the page exchanges the code GitHub hands back for a token that
 * acts as that person, and the installation counts only if that person can
 * reach it. GitHub answers that question, not the address.
 */
import { DeliveryError } from "./deliver.ts";

export interface OAuthApp {
  clientId: string;
  /** Never logged, never sent anywhere but GitHub's token endpoint. */
  clientSecret: string;
}

export interface VerifiedInstallation {
  installationId: number;
  /** Every repository of the installation this person can see, as `owner/name`. */
  repositories: string[];
}

const HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "invariant-updater",
};

/** Exchanges the code from the setup redirect for a token acting as that person. */
async function userToken(
  app: OAuthApp,
  code: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      ...HEADERS,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
    }),
  });
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    // GitHub answers 200 with an error for a code that is used or expired.
    throw new DeliveryError(
      `GitHub did not accept the authorization: ${data.error_description ?? response.statusText}`,
      401,
    );
  }
  return data.access_token;
}

/**
 * The installation, if the person who just authorized can reach it, with the
 * repositories of it they can see. Throws when they cannot: the installation
 * is someone else's, or the code was not theirs to use.
 */
export async function verifyInstallation(
  app: OAuthApp,
  code: string,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedInstallation> {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new DeliveryError("that is not an installation id", 400);
  }
  const token = await userToken(app, code, fetchImpl);
  const repositories: string[] = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
      { headers: { ...HEADERS, authorization: `Bearer ${token}` } },
    );
    if (response.status === 404 || response.status === 403) {
      throw new DeliveryError(
        "the person who authorized cannot reach that installation",
        403,
      );
    }
    if (!response.ok) {
      throw new DeliveryError(
        `listing the installation's repositories failed: ${response.statusText}`,
        response.status,
      );
    }
    const data = (await response.json()) as {
      total_count: number;
      repositories: { full_name: string }[];
    };
    repositories.push(...data.repositories.map((repository) => repository.full_name));
    if (data.repositories.length < 100 || repositories.length >= data.total_count) break;
  }
  return { installationId, repositories };
}
