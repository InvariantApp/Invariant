/**
 * Creates the GitHub App, once, by hand.
 *
 * Run it, open the URL it prints in a browser that is signed in to GitHub, and
 * click the button. The credentials GitHub returns are written straight to
 * `.secrets/github-app.json` and never printed, because the private key is the
 * app's whole identity and a terminal is a poor place to keep one.
 *
 * Deliberately not part of any automated flow. An app is a durable grant over
 * somebody's repositories, and creating one should take a person deciding to.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerApp } from "@invariant-app/github";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, ".secrets");
const OUT = join(OUT_DIR, "github-app.json");

const org = process.argv.includes("--org")
  ? process.argv[process.argv.indexOf("--org") + 1]
  : undefined;
const name = process.argv.includes("--name")
  ? (process.argv[process.argv.indexOf("--name") + 1] as string)
  : "Invariant Updater";

const registration = registerApp({
  name,
  ...(org ? { organization: org } : {}),
  homepage: "https://github.com/InvariantApp/Invariant",
  timeoutMs: 15 * 60_000,
});

console.log(`
Open this in a browser signed in to GitHub${org ? ` with admin rights on ${org}` : ""}:

    ${registration.url}

It shows exactly which permissions are being asked for, then hands you to
GitHub to confirm. Waiting.
`);

try {
  const app = await registration.credentials;

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    OUT,
    `${JSON.stringify(
      {
        appId: String(app.id),
        slug: app.slug,
        name: app.name,
        privateKey: app.pem,
        webhookSecret: app.webhookSecret,
        clientId: app.clientId,
        clientSecret: app.clientSecret,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await chmod(OUT, 0o600);

  // The id and the slug are public; everything else stays in the file.
  console.log(`Created "${app.name}" (app id ${app.id}, slug ${app.slug}).`);
  console.log(`Credentials written to .secrets/github-app.json, mode 600.`);
  console.log(
    `Install it on a repository: https://github.com/apps/${app.slug}/installations/new`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  registration.close();
}
