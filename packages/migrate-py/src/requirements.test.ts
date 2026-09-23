import { describe, expect, it } from "vitest";
import { markerHolds, requirementsOf, satisfies } from "./requirements.ts";

describe("what a wheel requires", () => {
  it("reads Requires-Dist lines in both of the forms wheels write", () => {
    const metadata = [
      "Metadata-Version: 2.1",
      "Name: openai",
      "Requires-Dist: httpx<1,>=0.23.0",
      "Requires-Dist: pydantic (<3,>=1.9.0)",
      'Requires-Dist: typing-extensions>=4.11; python_version < "3.13"',
      "Requires-Dist: numpy>=1; extra == 'datalib'",
      "Requires-Dist: requests[socks]",
    ].join("\n");
    expect(requirementsOf(metadata)).toEqual([
      { name: "httpx", specifier: "<1,>=0.23.0", marker: "" },
      { name: "pydantic", specifier: "<3,>=1.9.0", marker: "" },
      {
        name: "typing-extensions",
        specifier: ">=4.11",
        marker: 'python_version < "3.13"',
      },
      { name: "numpy", specifier: ">=1", marker: "extra == 'datalib'" },
      { name: "requests", specifier: "", marker: "" },
    ]);
  });

  it("holds markers for CPython 3.12 on Linux, and never an extra", () => {
    expect(markerHolds('python_version < "3.13"')).toBe(true);
    expect(markerHolds('python_version < "3.8"')).toBe(false);
    expect(markerHolds("extra == 'datalib'")).toBe(false);
    expect(markerHolds('sys_platform == "win32"')).toBe(false);
    expect(markerHolds('sys_platform == "win32" or python_version >= "3.10"')).toBe(true);
    expect(
      markerHolds(
        '(python_version >= "3.8" and python_version < "3.11") or os_name == "nt"',
      ),
    ).toBe(false);
    expect(markerHolds("something_unheard_of == 'x'")).toBe(true);
  });

  it("matches the PEP 440 specifiers SDKs use", () => {
    expect(satisfies("2.11.7", "<3,>=1.9.0")).toBe(true);
    expect(satisfies("3.0.0", "<3,>=1.9.0")).toBe(false);
    expect(satisfies("1.4.9", "~=1.4.5")).toBe(true);
    expect(satisfies("1.5.0", "~=1.4.5")).toBe(false);
    expect(satisfies("2.0.1", "==2.0.*")).toBe(true);
    expect(satisfies("2.1.0", "!=2.1.*")).toBe(false);
    expect(satisfies("0.28.1", "")).toBe(true);
  });
});
