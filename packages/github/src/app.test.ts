/**
 * Authenticating as the app, without an app.
 *
 * The JWT is signed with a key generated here, so the signature can be checked
 * against the public half rather than merely produced. Everything else is
 * exercised against a fake transport, which is enough because the interesting
 * behaviour is what this asks for and how it handles expiry, not how GitHub
 * replies.
 */
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { appApi, appJwt, appManifest, installationToken } from "./app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const CREDENTIALS = { appId: "123456", privateKey };

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

/** A fetch that records what it was asked and replies with a token. */
function fakeFetch(expiresInMs = 3_600_000) {
  const calls: { url: string; auth: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(url),
      auth: headers.get("authorization") ?? "",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(
      JSON.stringify({
        token: `ghs_${calls.length}`,
        expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("proving which app is calling", () => {
  it("signs a token the public key verifies", () => {
    const [header, payload, signature] = appJwt(CREDENTIALS).split(".");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(
      verifier.verify(publicKey, Buffer.from(signature as string, "base64url")),
    ).toBe(true);
    expect(decode(header as string)).toEqual({ alg: "RS256", typ: "JWT" });
  });

  it("backdates the token and keeps it under GitHub's ten minute ceiling", () => {
    const now = 1_800_000_000_000;
    const claims = decode(appJwt(CREDENTIALS, now).split(".")[1] as string);

    // A clock a few seconds fast is ordinary, and GitHub refuses a token whose
    // `iat` is in the future.
    expect(claims["iat"]).toBeLessThan(Math.floor(now / 1000));
    expect((claims["exp"] as number) - (claims["iat"] as number)).toBeLessThanOrEqual(
      600,
    );
    expect(claims["iss"]).toBe("123456");
  });

  it("says nothing in the payload beyond who is asking and for how long", () => {
    // It is signed with the app's whole identity, so anything else in here
    // would be something the key had vouched for without needing to.
    const claims = decode(appJwt(CREDENTIALS).split(".")[1] as string);
    expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "iss"]);
  });
});

describe("getting a token for one installation", () => {
  it("asks with the app JWT and narrows to the repositories it needs", async () => {
    const fetch = fakeFetch();
    const token = await installationToken(CREDENTIALS, 42, {
      repositories: ["consumer-a"],
      fetchImpl: fetch.impl,
    });

    expect(token.token).toBe("ghs_1");
    expect(fetch.calls[0]?.url).toContain("/app/installations/42/access_tokens");
    expect(fetch.calls[0]?.auth.startsWith("Bearer ey")).toBe(true);
    // An installation may cover repositories this migration is not for, and a
    // token that can reach them is a token that does not need to.
    expect(fetch.calls[0]?.body).toEqual({ repositories: ["consumer-a"] });
  });

  it("asks for the whole installation only when no repositories were named", async () => {
    const fetch = fakeFetch();
    await installationToken(CREDENTIALS, 42, { fetchImpl: fetch.impl });
    expect(fetch.calls[0]?.body).toBeUndefined();
  });

  it("reuses the token it already has", async () => {
    const fetch = fakeFetch();
    const api = appApi(CREDENTIALS, 42, { fetchImpl: fetch.impl });

    await api.request("GET", "/repos/acme/consumer-a");
    await api.request("GET", "/repos/acme/consumer-a");

    // One mint, two requests. Minting per call would be a request per request.
    const mints = fetch.calls.filter((call) => call.url.includes("access_tokens"));
    expect(mints).toHaveLength(1);
  });

  /**
   * A migration takes minutes, not seconds. A token fetched at the start can
   * expire partway through and leave a branch pushed and no pull request
   * opened, which is the worst moment for it to happen.
   */
  it("renews a token that is about to expire", async () => {
    const fetch = fakeFetch(30_000);
    const api = appApi(CREDENTIALS, 42, { fetchImpl: fetch.impl });

    await api.request("GET", "/repos/acme/consumer-a");
    await api.request("GET", "/repos/acme/consumer-a");

    const mints = fetch.calls.filter((call) => call.url.includes("access_tokens"));
    expect(mints).toHaveLength(2);
  });
});

describe("what the app asks a consumer to grant", () => {
  const manifest = appManifest({
    name: "Invariant Updater",
    url: "https://invariant.dev",
    redirectUrl: "http://localhost:7801/created",
  });

  it("asks for exactly the four permissions it uses", () => {
    expect(manifest["default_permissions"]).toEqual({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      checks: "read",
    });
  });

  /**
   * The list that matters is the one that is absent. These are written down in
   * `REFUSED_PERMISSIONS` and asserted here so that widening the grant is a
   * visible change to a test rather than a quiet edit to a form on a website.
   */
  it("asks for nothing that could change how the repository runs", () => {
    const asked = Object.keys(manifest["default_permissions"] as object);
    for (const refused of ["workflows", "actions", "administration", "members"]) {
      expect(asked).not.toContain(refused);
    }
  });

  it("is private, and does not ask to be public", () => {
    expect(manifest["public"]).toBe(false);
  });

  it("leaves webhooks off until there is somewhere to send them", () => {
    expect(manifest["hook_attributes"]).toEqual({ active: false });

    const withHook = appManifest({
      name: "Invariant Updater",
      url: "https://invariant.dev",
      redirectUrl: "http://localhost:7801/created",
      webhookUrl: "https://invariant.dev/hooks",
    });
    expect(withHook["hook_attributes"]).toEqual({
      url: "https://invariant.dev/hooks",
      active: true,
    });
  });
});
