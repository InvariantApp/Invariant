/**
 * The threat-model record, read the way launch gate L15 reads it.
 *
 * `manifest.json` beside this file maps every row of DESIGN 11.1, and every
 * attack M10.1 names, to the tests that send it. `manifest.test.ts` holds the
 * record to DESIGN.md and to the test files, so a row cannot be claimed
 * without a test that exists, and this turns it into the numbers the
 * scoreboard prints.
 */

export type RowStatus = "covered" | "partly covered" | "out of scope";

export interface TestReference {
  /** Relative to the repository root. */
  file: string;
  /** Titles, of a `describe`, an `it` or a Go test, written in that file as they are here. */
  titles: string[];
}

export interface ThreatRow {
  /** The row's first cell in DESIGN 11.1, exactly. */
  threat: string;
  status: RowStatus;
  /** What of the mitigation this repository holds, and the tests check. */
  here?: string;
  tests?: TestReference[];
  /** What of it lives in the service's repository. */
  elsewhere?: string;
  /** What of it is not built anywhere yet, each as a phrase the scoreboard lists. */
  gaps?: string[];
  notes?: string;
}

export interface ThreatManifest {
  rows: ThreatRow[];
  attacks: { attack: string; tests: TestReference[]; notes?: string }[];
  outOfScope: string[];
  found: string[];
}

export interface ThreatSummary {
  rows: number;
  covered: number;
  partly: number;
  outOfScope: number;
  /** Everything named as not built, across every row. */
  gaps: string[];
  attacks: number;
  found: number;
}

export function summarize(manifest: ThreatManifest): ThreatSummary {
  const count = (status: RowStatus) =>
    manifest.rows.filter((row) => row.status === status).length;
  return {
    rows: manifest.rows.length,
    covered: count("covered"),
    partly: count("partly covered"),
    outOfScope: count("out of scope"),
    gaps: manifest.rows.flatMap((row) => row.gaps ?? []),
    attacks: manifest.attacks.length,
    found: manifest.found.length,
  };
}
