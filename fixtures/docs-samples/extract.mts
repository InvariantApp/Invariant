/**
 * Pulls every TypeScript sample out of the adapter guides into one module per
 * guide: imports hoisted to the top, each sample in a block of its own so
 * two samples may each declare `runtime`, and the few names the prose takes
 * as given declared with their real types.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GUIDES = join(import.meta.dirname, "../../docs/adapters");
const OUT = join(import.meta.dirname, "src");

/** What each guide's prose assumes the reader already has. */
const GIVEN: Record<string, string> = {
  express: 'import type { Express } from "express";\ndeclare const app: Express;',
  koa: 'import type Koa from "koa";\ndeclare const app: Koa;',
  "node-http":
    'import type { RequestListener } from "node:http";\ndeclare const listener: RequestListener;',
  hono: 'import type { Hono, MiddlewareHandler } from "hono";\ndeclare const app: Hono;\ndeclare const authenticate: MiddlewareHandler;',
  nestjs: "declare class AppModule {}",
  quickstart: `import type { Hono, MiddlewareHandler } from "hono";
declare const app: Hono;
declare const yourAuth: MiddlewareHandler;
declare const log: { append(event: unknown): void };
declare function splitName(name: string): { first_name: string; last_name: string };
declare const inv: import("@invariant-app/runtime").InvariantRuntime;
declare const identity: NonNullable<Parameters<typeof import("@invariant-app/runtime").createRuntime>[0]["identity"]>;`,
};

/** Names a later sample uses that an earlier one defined, in its own block. */
const SHARED = `declare const client: ReturnType<typeof import("@invariant-app/client").createClient>;
declare const flags: ReturnType<typeof import("@invariant-app/flags").remoteFlags>;`;

const PAGES = [
  ...readdirSync(GUIDES)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({ guide: name.replace(/\.md$/, ""), file: `adapters/${name}` })),
  { guide: "quickstart", file: "quickstart.md" },
];

for (const { guide, file } of PAGES) {
  const samples = [
    ...readFileSync(join(GUIDES, "..", file), "utf8").matchAll(/```ts\n([\s\S]*?)```/g),
  ].map((match) => match[1] as string);
  if (samples.length === 0) continue;
  const imports = new Set<string>();
  const blocks = samples.map((sample) => {
    const body = sample.split("\n").filter((line) => {
      if (!/^import /.test(line)) return true;
      imports.add(line);
      return false;
    });
    // A module's default export has to be at its top; in a sample's block it
    // is checked as the value it exports.
    const checked = body.map((line) =>
      line.replace(/^export default /, "void ").replace(/^export const /, "const "),
    );
    return `{\n${checked.join("\n")}\n}`;
  });
  writeFileSync(
    join(OUT, `${guide}.ts`),
    `// Extracted from docs/${file} by extract.mts. Do not edit.\n${[...imports].join("\n")}\n${GIVEN[guide] ?? ""}\n${SHARED}\nexport {};\n\n${blocks.join("\n\n")}\n`,
  );
}

/**
 * The Go guide's samples, each the body of a function in one program that
 * `go vet` checks against the engine: the names the prose takes as given
 * (the service's own mux, the program's bytes) are declared once.
 */
const goSamples = [
  ...readFileSync(join(GUIDES, "go.md"), "utf8").matchAll(/```go\n([\s\S]*?)```/g),
].map((match) => match[1] as string);
writeFileSync(
  join(import.meta.dirname, "go/main.go"),
  `// Extracted from docs/adapters/go.md by extract.mts. Do not edit.
package main

import (
	"log"
	"net/http"
	"os"
	"sync/atomic"

	"github.com/InvariantApp/Invariant/engines/go/invariant"
	"github.com/InvariantApp/Invariant/engines/go/nethttp"
)

var (
	_       = log.Fatal
	_       = os.ReadFile
	_       atomic.Value
	_       = invariant.Load
	_       = nethttp.Handler
	mux     = http.NewServeMux()
	program []byte
)

${goSamples.map((sample, index) => `func sample${index}() {\n${sample}}`).join("\n\n")}

func main() {}
`,
);
