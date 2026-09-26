import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EngineResult, Sources } from "./engine.ts";
import { type Grown, grownVocabularies, grownVocabularySites } from "./grown.ts";

const release = (values: string[]) => {
  const site = mkdtempSync(join(tmpdir(), "grown-"));
  mkdirSync(join(site, "sdk"));
  writeFileSync(
    join(site, "sdk", "stop_reason.py"),
    `from typing_extensions import Literal\n\nStopReason = Literal[${values.map((value) => `"${value}"`).join(", ")}]\n`,
  );
  return site;
};

const stopReason: Grown = {
  name: "StopReason",
  before: new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use"]),
  added: ["model_context_window_exceeded"],
};

const sitesIn = async (text: string, grown: readonly Grown[] = [stopReason]) => {
  const file = "/repo/finish.py";
  const result = { edits: [], manual: [] } as unknown as EngineResult;
  await grownVocabularySites(new Sources(new Map([[file, text]])), grown, result);
  return result.manual.map((site) => `${site.line} ${site.reason}`);
};

describe("grownVocabularies", () => {
  it("finds the values a literal alias gained across the upgrade", () => {
    const old = release(["end_turn", "max_tokens"]);
    const next = release(["end_turn", "max_tokens", "compaction"]);
    expect(grownVocabularies(old, next)).toEqual([
      {
        name: "StopReason",
        before: new Set(["end_turn", "max_tokens"]),
        added: ["compaction"],
      },
    ]);
  });
});

describe("grownVocabularySites", () => {
  it("shows each case of a match on a vocabulary that gained a value", async () => {
    const text = [
      "match reason:",
      '    case "end_turn" | "stop_sequence":',
      "        return STOP",
      '    case "max_tokens":',
      "        return LENGTH",
      "    case _:",
      "        assert_never(reason)",
      "",
    ].join("\n");
    expect(await sitesIn(text)).toEqual([
      '2 the upgraded SDK\'s `StopReason` can now also be "model_context_window_exceeded", which nothing here decides on',
      '4 the upgraded SDK\'s `StopReason` can now also be "model_context_window_exceeded", which nothing here decides on',
    ]);
  });

  it("shows a comparison with several of the vocabulary's values", async () => {
    expect(
      await sitesIn('if reason in ("end_turn", "stop_sequence"):\n    pass\n'),
    ).toHaveLength(1);
  });

  it("leaves a decision that already names the new value, or names one value only", async () => {
    const handled =
      'match reason:\n    case "end_turn" | "model_context_window_exceeded":\n        pass\n    case "max_tokens":\n        pass\n';
    expect(await sitesIn(handled)).toEqual([]);
    expect(await sitesIn('if reason == "end_turn":\n    pass\n')).toEqual([]);
  });

  it("leaves a match on values no vocabulary lists together", async () => {
    expect(
      await sitesIn(
        'match mode:\n    case "end_turn":\n        pass\n    case "fast":\n        pass\n',
      ),
    ).toEqual([]);
  });

  it("does not take the cases of a match nested inside one for its own", async () => {
    const text = [
      "match reason:",
      '    case "tool_use":',
      "        match mode:",
      '            case "end_turn" | "max_tokens":',
      "                pass",
      '    case "stop_sequence":',
      "        pass",
      "",
    ].join("\n");
    expect((await sitesIn(text)).map((site) => site.split(" ")[0])).toEqual([
      "2",
      "6",
      "4",
    ]);
  });
});
