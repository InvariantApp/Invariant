/**
 * An installation id in an address proves nothing; the person who authorized
 * reaching that installation does.
 */
import { describe, expect, it } from "vitest";
import { verifyInstallation } from "./install.ts";

const APP = { clientId: "Iv1.abc", clientSecret: "shh" };

/** GitHub, as far as this needs it: one person, who can reach installation 7. */
function github(repositories: string[], codes = new Set(["good"])) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      const { code, client_secret } = JSON.parse(String(init?.body));
      return Response.json(
        codes.has(code) && client_secret === APP.clientSecret
          ? { access_token: "ghu_person" }
          : {
              error: "bad_verification_code",
              error_description: "The code is incorrect or expired.",
            },
      );
    }
    const match =
      /\/user\/installations\/(\d+)\/repositories\?per_page=100&page=(\d+)/.exec(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (!match || auth !== "Bearer ghu_person") return new Response("", { status: 401 });
    if (match[1] !== "7") return Response.json({ message: "Not Found" }, { status: 404 });
    const page = Number(match[2]);
    return Response.json({
      total_count: repositories.length,
      repositories: repositories
        .slice((page - 1) * 100, page * 100)
        .map((full_name) => ({ full_name })),
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("verifying an installation", () => {
  it("lists what the person can see of an installation they can reach, every page of it", async () => {
    const names = Array.from({ length: 130 }, (_, i) => `acme/repo-${i}`);
    const { fetchImpl, seen } = github(names);
    const verified = await verifyInstallation(APP, "good", 7, fetchImpl);
    expect(verified).toEqual({ installationId: 7, repositories: names });
    expect(seen.filter((url) => url.includes("/repositories")).length).toBe(2);
  });

  it("refuses an installation the person cannot reach, whatever the address said", async () => {
    await expect(
      verifyInstallation(APP, "good", 8, github(["acme/a"]).fetchImpl),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a code GitHub does not accept", async () => {
    await expect(
      verifyInstallation(APP, "used", 7, github(["acme/a"]).fetchImpl),
    ).rejects.toThrow(/incorrect or expired/);
  });

  it("refuses what is not an installation id before asking GitHub anything", async () => {
    const { fetchImpl, seen } = github([]);
    await expect(
      verifyInstallation(APP, "good", Number.NaN, fetchImpl),
    ).rejects.toMatchObject({
      status: 400,
    });
    expect(seen).toEqual([]);
  });
});
