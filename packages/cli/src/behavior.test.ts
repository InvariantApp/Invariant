/**
 * What the gate does with a change it cannot express.
 *
 * The IR is small on purpose, so there are real changes no op covers: one field
 * becoming two, a side effect moving, a union reshaped. Before this existed,
 * a provider who hit one was simply stuck: the gate named six unrelated-looking
 * deltas, `propose` drafted nothing, and writing a `behavior` Change by hand
 * changed neither, because nothing let it account for anything.
 *
 * The way out cannot be a wildcard. An escape hatch that waves away whatever is
 * unexplained is not an escape hatch, it is the gate switched off. So a
 * behavior Change lists the deltas it covers, one line each, exactly as the
 * gate prints them, and the gate refuses the release if that list and reality
 * have drifted apart in either direction.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oasdiffAvailable } from "@invariant/diff";
import { afterEach, describe, expect, it } from "vitest";
import { check, renderReport } from "./check.ts";
import { loadConfig } from "./config.ts";

const hasOasdiff = await oasdiffAvailable();

function contacts(properties: Record<string, unknown>, required: string[]): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "Contacts", version: "1" },
    paths: {
      "/v1/contacts": {
        post: {
          operationId: "contacts.create",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Contact" },
              },
            },
          },
          responses: {
            "201": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Contact" },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: { Contact: { type: "object", required, properties } },
    },
  });
}

let scratch: string | undefined;

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A field split: the canonical change that no op in the catalog can express. */
async function splitProvider(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), "invariant-behavior-"));
  await mkdir(join(scratch, "openapi"), { recursive: true });
  await mkdir(join(scratch, "invariant/changes"), { recursive: true });

  await writeFile(
    join(scratch, "openapi/old.json"),
    contacts({ name: { type: "string" } }, ["name"]),
    "utf8",
  );
  await writeFile(
    join(scratch, "openapi/head.json"),
    contacts({ first_name: { type: "string" }, last_name: { type: "string" } }, [
      "first_name",
      "last_name",
    ]),
    "utf8",
  );
  await writeFile(
    join(scratch, "invariant.yaml"),
    `api: contacts
spec:
  current: openapi/head.json
  currentLabel: "2026-09-20"
  released:
    "2026-01-01": openapi/old.json
`,
    "utf8",
  );
  return scratch;
}

async function declare(root: string, covers: readonly string[]): Promise<void> {
  await writeFile(
    join(root, "invariant/changes/chg_contact_name_split.yaml"),
    `irVersion: 1
id: chg_contact_name_split
summary: "Contact.name became first_name and last_name. The handler branches on it."
assertions:
  side_effects_unchanged: true
ops:
  - op: behavior
    flag: chg_contact_name_split
    covers:
${covers.map((line) => `      - ${JSON.stringify(line)}`).join("\n")}
`,
    "utf8",
  );
}

const config = async (root: string) => loadConfig(join(root, "invariant.yaml"));

describe.skipIf(!hasOasdiff)("a change no op can express", () => {
  it("blocks, and hands back the exact lines to acknowledge", async () => {
    const root = await splitProvider();
    const report = await check(await config(root));

    expect(report.result).toBe("block");
    expect(report.steps[0]?.unexplained.length).toBe(6);

    // The rendered block has to be paste-ready. Asking a provider to retype the
    // gate's own output is how a discipline decays into a formality, and a
    // mistyped line silently covers nothing.
    const rendered = renderReport(report);
    expect(rendered).toContain("- op: behavior");
    expect(rendered).toContain("covers:");
    for (const entry of report.steps[0]?.unexplained ?? []) {
      expect(rendered).toContain(JSON.stringify(entry));
    }
  });

  it("accepts the acknowledgement, and never calls it a pass", async () => {
    const root = await splitProvider();
    const blocked = await check(await config(root));
    await declare(root, blocked.steps[0]?.unexplained ?? []);

    const report = await check(await config(root));

    // Not blocked, because it is accounted for. Not passed, because something
    // here genuinely breaks unless the provider's own code handles it, and no
    // layer of this tool can check that it does.
    expect(report.result).toBe("warn");
    expect(report.steps[0]?.unexplained).toEqual([]);
    expect(report.steps[0]?.accounted).toBe(6);
    expect(report.warnings.join("\n")).toContain("Nothing transforms them");

    // The evidence has to say it too. A bundle that records this as an ordinary
    // closure pass would be a bundle that lies about what was proved.
    const closure = report.evidence.find((entry) => entry.kind === "E2-closure");
    expect(closure?.result).toBe("pass");
    expect(closure?.summary).toContain(
      "handled in provider code rather than transformed",
    );
  });

  /**
   * The failure mode that would make this a rubber stamp.
   *
   * An acknowledgement written once must not keep absorbing whatever happens
   * afterwards. Here a second, unrelated break appears in the same schema, and
   * the acknowledgement covering the split must not quietly swallow it.
   */
  it("does not absorb a break nobody acknowledged", async () => {
    const root = await splitProvider();
    const blocked = await check(await config(root));
    await declare(root, blocked.steps[0]?.unexplained ?? []);

    await writeFile(
      join(root, "openapi/head.json"),
      contacts(
        {
          first_name: { type: "string" },
          last_name: { type: "string" },
          locale: { type: "string" },
        },
        ["first_name", "last_name", "locale"],
      ),
      "utf8",
    );

    const report = await check(await config(root));

    expect(report.result).toBe("block");
    expect(report.steps[0]?.unexplained.join("\n")).toContain("locale");
  });

  /**
   * And the mirror of it: a claim for something that no longer happens.
   *
   * Left alone, the file would read as a considered acknowledgement of a break
   * that is not there, which is worse than no acknowledgement, because the next
   * reader trusts it.
   */
  it("refuses a claim the release no longer breaks", async () => {
    const root = await splitProvider();
    const blocked = await check(await config(root));
    await declare(root, [
      ...(blocked.steps[0]?.unexplained ?? []),
      "request-property-removed at POST /v1/contacts: removed the request property `nickname`",
    ]);

    const report = await check(await config(root));

    expect(report.result).toBe("block");
    expect(report.steps[0]?.stale).toEqual([
      "request-property-removed at POST /v1/contacts: removed the request property `nickname`",
    ]);
    expect(renderReport(report)).toContain("which no longer happens");
  });
});
