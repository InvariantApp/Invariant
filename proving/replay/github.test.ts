import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openapiCommitOf } from "./github.mts";

describe("openapiCommitOf", () => {
  it("reads the description commit a go-github module records", () => {
    const dir = mkdtempSync(join(tmpdir(), "go-github-"));
    writeFileSync(
      join(dir, "openapi_operations.yaml"),
      "operations:\n  - name: GET /hub\nopenapi_commit: 1111111111111111111111111111111111111111\n",
    );
    expect(openapiCommitOf(dir)).toBe("1111111111111111111111111111111111111111");
  });

  it("says nothing for a module that records no commit", () => {
    const dir = mkdtempSync(join(tmpdir(), "go-github-"));
    expect(openapiCommitOf(dir)).toBeUndefined();
    writeFileSync(join(dir, "openapi_operations.yaml"), "operations: []\n");
    expect(openapiCommitOf(dir)).toBeUndefined();
  });
});
