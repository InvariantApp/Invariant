import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenApiDocument } from "@invariant-app/contract";
import { describe, expect, it } from "vitest";
import { stainlessClasses, stainlessTypes } from "./stainless.mts";

describe("stainlessTypes", () => {
  const site = mkdtempSync(join(tmpdir(), "stainless-"));
  const beta = join(site, "sdk/types/beta");
  mkdirSync(join(beta, "sessions"), { recursive: true });
  writeFileSync(join(site, "sdk/types/__init__.py"), "from .message import Message\n");
  writeFileSync(
    join(site, "sdk/types/message.py"),
    "class Message(BaseModel):\n    id: str\n    content: list\n",
  );
  writeFileSync(
    join(site, "sdk/types/tool_param.py"),
    "class ToolParam(TypedDict):\n    name: str\n",
  );
  writeFileSync(join(beta, "__init__.py"), "from .beta_usage import BetaUsage\n");
  writeFileSync(
    join(beta, "beta_usage.py"),
    "class BetaUsage(BaseModel):\n    input_tokens: int\n    output_tokens: int\n",
  );
  // Not re-exported by its package, so named through its own module.
  writeFileSync(
    join(beta, "sessions/stats.py"),
    "class SessionStats(BaseModel):\n    turns: int\n    tokens: int\n",
  );
  const document = {
    components: {
      schemas: {
        Message: { properties: { id: {}, content: {} } },
        Tool: { properties: { name: {} } },
        Usage_Report: { properties: { input_tokens: {}, output_tokens: {} } },
        Stats: { properties: { turns: {}, tokens: {} } },
        Unmatched: { properties: { a: {}, b: {} } },
      },
    },
  } as unknown as OpenApiDocument;

  it("finds each schema's class by name, request name, or fields", () => {
    expect(stainlessTypes(document, stainlessClasses(site, "sdk"))).toEqual({
      Message: "sdk.types.Message",
      Tool: "sdk.types.tool_param.ToolParam",
      Usage_Report: "sdk.types.beta.BetaUsage",
      Stats: "sdk.types.beta.sessions.stats.SessionStats",
    });
  });
});
