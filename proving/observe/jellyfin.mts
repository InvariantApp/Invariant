/**
 * `invariant observe` in front of Jellyfin 10.11 (M5.8).
 *
 * Jellyfin's OpenAPI document is generated from its controllers by
 * Swashbuckle, and generated documents are where a gate's first impression is
 * made or lost: a field the generator marks optional that is always there, a
 * value it never says can be null. `observe` is the rung before adopting
 * anything, so it is proven where that matters: the released image, the
 * document that same server serves, and the traffic a first-time client
 * sends it (the setup wizard, signing in, then reading the library, the
 * users, the system and the settings), all through the observer, which
 * adapts nothing and records no value, only where the answers and the
 * document disagree.
 *
 *   node --import tsx proving/observe/jellyfin.mts [--record]
 */
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { loadConfig, observe, renderObservation } from "@invariant-app/cli";

const IMAGE =
  "jellyfin/jellyfin:10.11.11@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db";
const LABEL = "10.11.11";
const HERE = join(import.meta.dirname, "jellyfin");
const WORK = join(import.meta.dirname, "../../.cache/observe/jellyfin");
const CONTAINER = "invariant-observe-jellyfin";

const log = (line: string) => process.stderr.write(`${line}\n`);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function until(url: string, seconds: number): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} never answered`);
}

await rm(WORK, { recursive: true, force: true });
await mkdir(join(WORK, "specs"), { recursive: true });
const port = await freePort();
const upstream = `http://127.0.0.1:${port}`;

spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
const started = spawnSync(
  "docker",
  // Capped, since it shares its machine: a first start needs a few hundred MB.
  [
    "run",
    "-d",
    "--rm",
    "--name",
    CONTAINER,
    "--memory",
    "1g",
    "-p",
    `127.0.0.1:${port}:8096`,
    IMAGE,
  ],
  { encoding: "utf8" },
);
if (started.status !== 0) throw new Error(`starting Jellyfin failed: ${started.stderr}`);

try {
  log(`Jellyfin ${LABEL} on ${upstream}`);
  // /health and the public system info answer while the server is still
  // checking its storage; everything else answers a 503 page until it is
  // done, and the wizard's first question is the first real answer.
  await until(`${upstream}/Startup/Configuration`, 300);
  await until(`${upstream}/api-docs/openapi.json`, 120);

  // The document the release serves about itself, which is what a provider
  // generating theirs would point the gate at.
  const served = await fetch(`${upstream}/api-docs/openapi.json`);
  if (!served.ok) throw new Error(`/api-docs/openapi.json answered ${served.status}`);
  await writeFile(join(WORK, "specs", `${LABEL}.json`), await served.text(), "utf8");
  await writeFile(
    join(WORK, "invariant.yaml"),
    [
      "api: jellyfin",
      "spec:",
      `  current: specs/${LABEL}.json`,
      `  currentLabel: "${LABEL}"`,
      "  released:",
      `    "${LABEL}": specs/${LABEL}.json`,
      "",
    ].join("\n"),
    "utf8",
  );

  const observer = await observe(await loadConfig(join(WORK, "invariant.yaml")), {
    upstream,
    port: 0,
    samplePercent: 100,
    maxBodyBytes: 4_000_000,
  });

  const client =
    'Client="invariant-observe", Device="ci", DeviceId="invariant-observe", Version="1.0.0"';
  let authorization = `MediaBrowser ${client}`;
  const sent: { request: string; status: number }[] = [];
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${observer.url}${path}`, {
      method,
      headers: {
        authorization,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    sent.push({ request: `${method} ${path.split("?")[0]}`, status: response.status });
    const text = await response.text();
    try {
      return text === "" ? undefined : JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  // A first-time client: the setup wizard, as the web client runs it.
  await call("GET", "/System/Info/Public");
  await call("GET", "/Startup/Configuration");
  await call("POST", "/Startup/Configuration", {
    UICulture: "en-US",
    MetadataCountryCode: "US",
    PreferredMetadataLanguage: "en",
  });
  await call("GET", "/Startup/User");
  await call("POST", "/Startup/User", { Name: "observer", Password: "throwaway" });
  await call("POST", "/Startup/RemoteAccess", { EnableRemoteAccess: true });
  await call("POST", "/Startup/Complete");
  await call("GET", "/Users/Public");
  await call("GET", "/QuickConnect/Enabled");
  await call("GET", "/Branding/Configuration");

  // Signed in, then what a client reads on its first screens.
  const signedIn = (await call("POST", "/Users/AuthenticateByName", {
    Username: "observer",
    Pw: "throwaway",
  })) as { AccessToken?: string; User?: { Id?: string } } | undefined;
  if (!signedIn?.AccessToken || !signedIn.User?.Id) {
    throw new Error(`signing in gave no token: ${JSON.stringify(sent)}`);
  }
  authorization = `MediaBrowser Token="${signedIn.AccessToken}", ${client}`;
  const user = signedIn.User.Id;
  for (const path of [
    "/Users",
    "/Users/Me",
    `/Users/${user}`,
    "/System/Info",
    "/System/Configuration",
    "/System/Endpoint",
    "/System/Logs",
    "/System/ActivityLog/Entries?limit=50",
    "/Library/VirtualFolders",
    "/Library/MediaFolders",
    "/Library/PhysicalPaths",
    `/UserViews?userId=${user}`,
    `/Items?userId=${user}&recursive=true&limit=50`,
    `/Items/Latest?userId=${user}`,
    `/UserItems/Resume?userId=${user}`,
    "/Items/Filters",
    "/Genres",
    "/Studios",
    "/Persons",
    "/Artists",
    "/MusicGenres",
    "/Sessions",
    "/Plugins",
    "/Packages",
    "/Repositories",
    "/ScheduledTasks",
    "/Devices",
    "/Auth/Keys",
    "/Auth/Providers",
    "/Auth/PasswordResetProviders",
    "/LiveTv/Info",
    "/Localization/Cultures",
    "/Localization/Countries",
    "/Localization/ParentalRatings",
    "/Localization/Options",
    `/DisplayPreferences/usersettings?userId=${user}&client=emby`,
    "/Environment/Drives",
    "/Environment/DefaultDirectoryBrowser",
    "/Playlists?limit=10",
    "/Search/Hints?searchTerm=a",
    "/Shows/NextUp?limit=10",
    "/SyncPlay/List",
    "/Trickplay/Configuration",
    "/web/ConfigurationPages",
  ]) {
    await call("GET", path);
  }

  // A library, so the item endpoints answer with an item rather than nothing.
  await call(
    "POST",
    "/Library/VirtualFolders?name=Films&collectionType=movies&paths=%2Fmedia&refreshLibrary=false",
    { LibraryOptions: {} },
  );
  const folders = (await call("GET", "/Library/VirtualFolders")) as
    | { ItemId?: string }[]
    | undefined;
  const folder = folders?.[0]?.ItemId;
  if (folder) {
    for (const path of [
      `/Items/${folder}?userId=${user}`,
      `/Items?userId=${user}&parentId=${folder}`,
      `/Items/${folder}/Ancestors?userId=${user}`,
      `/Items/${folder}/Similar?userId=${user}`,
      `/Items/${folder}/ThemeMedia?userId=${user}`,
      `/Items/${folder}/Images`,
      "/Items/Counts",
      `/Library/VirtualFolders`,
    ]) {
      await call("GET", path);
    }
  }

  const report = await observer.close();
  process.stdout.write(`${renderObservation(report)}\n`);
  const result = {
    server: IMAGE,
    document: "/api-docs/openapi.json, as the same server serves it",
    requests: sent.length,
    statuses: Object.fromEntries(
      [...new Set(sent.map((entry) => entry.status))]
        .sort()
        .map((status) => [
          status,
          sent.filter((entry) => entry.status === status).length,
        ]),
    ),
    answers: report.answers,
    checked: report.checked,
    held: report.held,
    broke: report.broke,
    unknownOperations: report.unknownOperations,
    undescribed: report.undescribed,
    places: report.places,
  };
  if (process.argv.includes("--record")) {
    await mkdir(HERE, { recursive: true });
    await writeFile(
      join(HERE, "results.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
  }
} finally {
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
}
