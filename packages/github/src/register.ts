/**
 * Creating the GitHub App, once, from a browser that is already signed in.
 *
 * GitHub deliberately has no API for this. The only ways to create an app are
 * a form and a manifest flow, and both end with a person clicking a button
 * while signed in, which is the right design: an app is a durable grant over
 * somebody's repositories and should not be creatable by anything holding a
 * token.
 *
 * So this serves one page on localhost that posts the manifest, waits for the
 * redirect, and exchanges the one-time code for the credentials. The person
 * clicks once. Nothing is typed, copied, or pasted, which matters because the
 * private key GitHub returns is the app's whole identity and should not travel
 * through a terminal, a chat window, or a clipboard on the way to a file.
 *
 * It listens on loopback only, serves exactly two paths, and stops as soon as
 * it has an answer.
 */
import { createServer } from "node:http";
import { appManifest, type ConvertedApp, convertManifestCode } from "./app.ts";

export interface RegisterOptions {
  /** The app's name, which has to be unique across GitHub. */
  name: string;
  /** The organisation the app belongs to, or undefined for a personal account. */
  organization?: string;
  /** Where the app's own page lives. */
  homepage: string;
  /** Where GitHub should deliver webhooks, if anywhere yet. */
  webhookUrl?: string;
  port?: number;
  /** Give up rather than listening forever. */
  timeoutMs?: number;
}

export interface Registration {
  /** Open this, in a browser signed in to GitHub. */
  url: string;
  /** Resolves once the app exists, or rejects on timeout. */
  credentials: Promise<ConvertedApp>;
  /** Stop listening without waiting. */
  close: () => void;
}

function page(target: string, manifest: Record<string, unknown>): string {
  // A form rather than a redirect, because the manifest goes in a POST body and
  // is far too long to survive as a query parameter.
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create the Invariant GitHub App</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;color:#111}
 h1{font-size:1.4rem;margin:0 0 1rem}
 ul{padding-left:1.2rem} li{margin:.3rem 0}
 code{background:#f4f4f5;padding:.1rem .3rem;border-radius:3px;font-size:.9em}
 button{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:6px;background:#1f2328;color:#fff;cursor:pointer}
 .muted{color:#57606a;font-size:.92rem}
</style></head>
<body>
<h1>Create the Invariant GitHub App</h1>
<p>This asks GitHub for an app with exactly these permissions, and nothing else:</p>
<ul>
 <li><code>metadata: read</code></li>
 <li><code>contents: write</code> - to push the migration branch</li>
 <li><code>pull_requests: write</code> - to open the draft pull request</li>
 <li><code>checks: read</code> - to see whether your own CI passed</li>
</ul>
<p class="muted">No <code>workflows</code>, no <code>actions</code>, no <code>administration</code>,
no organisation scope. It cannot merge anything.</p>
<form id="f" method="post" action="${target}">
 <input type="hidden" name="manifest" id="m">
 <button type="submit">Create the app on GitHub</button>
</form>
<script>
 document.getElementById("m").value = ${JSON.stringify(JSON.stringify(manifest))};
 // Submitted by hand, not automatically: the page above is the point.
</script>
</body></html>`;
}

function done(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Invariant</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem}</style>
</head><body><h1>${message}</h1><p>You can close this tab.</p></body></html>`;
}

/**
 * Starts the flow and hands back the URL to open.
 *
 * Deliberately not opening a browser itself. Whichever browser is signed in to
 * GitHub is the person's, and guessing at it is how this ends up driving the
 * wrong profile or a headless one with no session at all.
 */
export function registerApp(options: RegisterOptions): Registration {
  const port = options.port ?? 7801;
  const origin = `http://localhost:${port}`;
  const manifest = appManifest({
    name: options.name,
    url: options.homepage,
    redirectUrl: `${origin}/created`,
    ...(options.webhookUrl ? { webhookUrl: options.webhookUrl } : {}),
  });

  const target = options.organization
    ? `https://github.com/organizations/${options.organization}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  const server = createServer();
  let settle: (value: ConvertedApp) => void;
  let fail: (error: Error) => void;
  const credentials = new Promise<ConvertedApp>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });

  const close = () => {
    clearTimeout(timer);
    server.close();
  };

  const timer = setTimeout(
    () => {
      close();
      fail(new Error("nobody completed the app creation in time"));
    },
    options.timeoutMs ?? 10 * 60_000,
  );
  timer.unref?.();

  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", origin);

    if (url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(page(target, manifest));
      return;
    }

    if (url.pathname === "/created") {
      const code = url.searchParams.get("code");
      if (!code) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(done("GitHub did not send a code back."));
        return;
      }

      convertManifestCode(code)
        .then((app) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(done(`Created ${app.name}.`));
          close();
          settle(app);
        })
        .catch((error: Error) => {
          response.writeHead(500, { "content-type": "text/html; charset=utf-8" });
          response.end(done("Could not convert the code."));
          close();
          fail(error);
        });
      return;
    }

    response.writeHead(404).end();
  });

  // Loopback only. This page creates an app on somebody's account and has no
  // business being reachable from anywhere but this machine.
  server.listen(port, "127.0.0.1");

  return { url: origin, credentials, close };
}
