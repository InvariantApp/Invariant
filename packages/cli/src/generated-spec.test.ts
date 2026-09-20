/**
 * Providers whose specification is generated from their code.
 *
 * Which is most of them, and they are the ones this tool is hardest on: every
 * other check reasons about the OpenAPI document, so a document that has not
 * caught up with a handler makes the gate confident about an API that does not
 * exist. The conformance layer catches that, but "blocked until you fix your
 * OpenAPI" is a poor first thing to hear, and the commonest cause is not a
 * mistake at all - it is having changed a handler and not rerun the generator.
 *
 * So the generator can be named in the configuration and runs at gate time.
 * The gate then reads what the code says right now, and a conformance failure
 * becomes a real finding rather than a chore.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.ts";

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

const SPEC = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Generated", version: "1" },
  paths: {},
});

/** A repository where the current specification does not exist until built. */
async function codeFirst(script: string, current: string): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-codefirst-"));
  await mkdir(join(scratch, "openapi"), { recursive: true });

  const generator = join(scratch, "generate.sh");
  await writeFile(generator, `#!/bin/sh\n${script}\n`, "utf8");
  await chmod(generator, 0o755);

  await writeFile(
    join(scratch, "invariant.yaml"),
    `api: generated
spec:
  currentLabel: "2026-09-20"
  current:${current}
`,
    "utf8",
  );
  return scratch;
}

describe("a specification that is generated, not written", () => {
  it("runs the generator, so the gate reads what the code says now", async () => {
    const root = await codeFirst(
      `cat > "$(dirname "$0")/openapi/head.json" <<'EOF'\n${SPEC}\nEOF`,
      `\n    command: ./generate.sh\n    out: openapi/head.json`,
    );

    const config = await loadConfig(join(root, "invariant.yaml"));

    expect(config.currentSpec).toBe(join(root, "openapi/head.json"));
    // The file did not exist until the generator ran, which is the whole point:
    // nothing stale can be read, because there was nothing to read.
    const written = await import("node:fs/promises").then((fs) =>
      fs.readFile(config.currentSpec, "utf8"),
    );
    expect(JSON.parse(written)).toMatchObject({ info: { title: "Generated" } });
  });

  it("still takes a plain path, for a provider who writes OpenAPI by hand", async () => {
    const root = await codeFirst("exit 1", " openapi/head.json");
    await writeFile(join(root, "openapi/head.json"), SPEC, "utf8");

    const config = await loadConfig(join(root, "invariant.yaml"));

    // The generator that would have failed is never run, because none was named.
    expect(config.currentSpec).toBe(join(root, "openapi/head.json"));
  });

  /**
   * A failing generator must not read as a stale specification. They are fixed
   * in completely different places, and the wrong message costs an afternoon.
   */
  it("says the generator failed, and does not blame the specification", async () => {
    const root = await codeFirst(
      "echo 'cannot resolve module' >&2\nexit 1",
      `\n    command: ./generate.sh\n    out: openapi/head.json`,
    );

    await expect(loadConfig(join(root, "invariant.yaml"))).rejects.toThrow(
      /spec\.current\.command failed/,
    );
  });

  it("refuses a generator that claims to write a file it does not", async () => {
    const root = await codeFirst(
      "true",
      `\n    command: ./generate.sh\n    out: openapi/head.json`,
    );

    await expect(loadConfig(join(root, "invariant.yaml"))).rejects.toThrow(
      /wrote no openapi\/head\.json/,
    );
  });

  it("asks which file the generator writes, rather than guessing", async () => {
    const root = await codeFirst("true", `\n    command: ./generate.sh`);

    await expect(loadConfig(join(root, "invariant.yaml"))).rejects.toThrow(ConfigError);
    await expect(loadConfig(join(root, "invariant.yaml"))).rejects.toThrow(
      /needs an "out"/,
    );
  });
});
