/**
 * `invariant publish` and `invariant status`: the release process talking to
 * the hosted service.
 *
 * `release` signs a bundle and keeps it in `invariant/bundles`; `publish`
 * sends what is there, so publishing is a separate, repeatable step a CI can
 * retry: the service answers a bundle it already has as already published,
 * and nothing is sent twice. `status` asks the service what production is
 * using, which is the evidence `retire` needs.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Contract,
  createClient,
  type DsseEnvelope,
  type Impact,
} from "@invariant/client";
import type { InvariantConfig } from "./config.ts";

/** The hosted service, unless INVARIANT_URL names another (a self-hosted one, say). */
export const DEFAULT_SERVICE_URL = "https://invariant-cloud.fly.dev";

export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

export type Client = ReturnType<typeof createClient>;

/** The client for the service, from the environment a CI job has. */
export function clientFromEnv(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
): { client: Client; url: string } {
  const token = env["INVARIANT_TOKEN"];
  if (!token) {
    throw new ServiceError(
      "INVARIANT_TOKEN is not set. Issue a token in the dashboard (Tokens, with the publish " +
        "scope for publishing, read for status) and store it as a CI secret.",
    );
  }
  const url = env["INVARIANT_URL"] || DEFAULT_SERVICE_URL;
  return {
    url,
    client: createClient({
      baseUrl: url,
      token,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
  };
}

export interface Published {
  label: string;
  digest: string;
  created: boolean;
}

/** Sends every signed bundle in `invariant/bundles`, or only `label`'s. */
export async function publishBundles(
  config: InvariantConfig,
  client: Client,
  label?: string,
): Promise<Published[]> {
  const dir = join(config.invariantDir, "bundles");
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((name) => name.endsWith(".dsse.json"))
    .filter((name) => label === undefined || name === `${label}.dsse.json`)
    .sort();
  if (files.length === 0) {
    throw new ServiceError(
      label === undefined
        ? `There are no signed releases in ${dir}. Run \`invariant release\` first.`
        : `There is no signed release ${label} in ${dir}.`,
    );
  }
  const published: Published[] = [];
  for (const file of files) {
    const envelope = JSON.parse(await readFile(join(dir, file), "utf8")) as DsseEnvelope;
    const answer = await client.publishBundle(envelope);
    published.push({
      label: file.slice(0, -".dsse.json".length),
      digest: answer.digest,
      created: answer.created,
    });
  }
  return published;
}

export function renderPublished(published: readonly Published[], url: string): string {
  return `${published
    .map(
      (p) =>
        `${p.created ? "published" : "already published"}  ${p.label}  ${p.digest.slice(0, 19)}…`,
    )
    .join("\n")}\n${url}\n`;
}

/** What production is using, per contract, from the service's counters. */
export async function status(
  client: Client,
  days = 30,
): Promise<{ contracts: Contract[]; impact: Impact }> {
  const [contracts, impact] = await Promise.all([
    client.listContracts(),
    client.getImpact({ days }),
  ]);
  return { contracts, impact };
}

export function renderStatus(result: { contracts: Contract[]; impact: Impact }): string {
  const usage = new Map(result.impact.contracts.map((c) => [c.label, c]));
  const rows = [...result.contracts].reverse().map((contract) => {
    const used = usage.get(contract.label);
    const note =
      contract.status === "current"
        ? "what your handlers speak"
        : used === undefined
          ? "no counters"
          : used.retirable
            ? `unused for ${result.impact.days} days: safe to retire`
            : `${used.requests} requests from ${used.consumers} consumers in ${result.impact.days} days`;
    return `${contract.label.padEnd(12)} ${contract.status.padEnd(9)} ${note}`;
  });
  return `${rows.join("\n")}\n`;
}
