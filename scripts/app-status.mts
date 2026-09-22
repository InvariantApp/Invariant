/**
 * What the GitHub App is, and where it is installed.
 *
 * Reads `.secrets/github-app.json`, authenticates as the app, and prints what
 * GitHub says back. Useful for the obvious reason and for a less obvious one:
 * the permissions a form was filled in with months ago are not necessarily the
 * permissions the app has now, and this is the only place that asks rather than
 * assumes.
 *
 * It prints the app id, the slug and the grants. It never prints the key.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { apiFromFetch, appJwt } from "@invariant-app/github";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CREDENTIALS = join(ROOT, ".secrets/github-app.json");

interface Stored {
  appId: string;
  privateKey: string;
}

interface App {
  id: number;
  slug: string;
  name: string;
  owner: { login: string };
  permissions: Record<string, string>;
  events: string[];
}

interface Installation {
  id: number;
  account: { login: string };
  repository_selection: string;
  permissions: Record<string, string>;
}

const stored = JSON.parse(await readFile(CREDENTIALS, "utf8")) as Stored;
const api = apiFromFetch(appJwt({ appId: stored.appId, privateKey: stored.privateKey }));

const app = await api.request<App>("GET", "/app");
console.log(`${app.data.name}`);
console.log(
  `  id ${app.data.id}, slug ${app.data.slug}, owned by ${app.data.owner.login}`,
);
console.log(
  `  permissions: ${Object.entries(app.data.permissions)
    .map(([name, level]) => `${name}=${level}`)
    .sort()
    .join(", ")}`,
);
console.log(`  events: ${app.data.events.join(", ") || "none"}`);

// The list that matters is the one that should be empty. These are refused in
// link.ts, and an app that has picked one up since is worth noticing here
// rather than the first time it uses it.
const REFUSED = ["workflows", "actions", "administration", "members"];
const held = REFUSED.filter((name) => name in app.data.permissions);
console.log(
  held.length === 0
    ? "  holds none of the refused permissions"
    : `  HOLDS REFUSED PERMISSIONS: ${held.join(", ")}`,
);

const installations = await api.request<Installation[]>("GET", "/app/installations");
console.log(`\ninstallations: ${installations.data.length}`);
for (const installation of installations.data) {
  console.log(
    `  id ${installation.id} on ${installation.account.login} (${installation.repository_selection})`,
  );

  if (installation.repository_selection !== "all") {
    const token = await api.request<{ token: string }>(
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
    );
    const repos = await apiFromFetch(token.data.token).request<{
      repositories: { full_name: string }[];
    }>("GET", "/installation/repositories");
    for (const repo of repos.data.repositories) console.log(`    ${repo.full_name}`);
  }
}

if (installations.data.length === 0) {
  console.log(`\nInstall it: https://github.com/apps/${app.data.slug}/installations/new`);
}
