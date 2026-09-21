/**
 * Calibration has to be repeatable before a comparison against it means
 * anything.
 *
 * The differential check runs the old build twice and treats whatever differs
 * between those two runs as volatile: generated identifiers, timestamps,
 * anything the build does not promise to reproduce. Everything else has to match
 * the new build exactly.
 *
 * Steps missing from the second run used to be skipped. That looks harmless and
 * is the opposite of harmless: a step with no calibration has no volatile paths,
 * so every value it derives from the clock is then reported as a difference
 * between the two builds. It failed exactly that way once, under load, on a
 * fixture whose timestamps come from the second its server started, and the
 * three differences it reported were all the same clock tick.
 */
import { describe, expect, it } from "vitest";
import { CalibrationError, type StepObservation, volatilePaths } from "./differential.ts";

const step = (id: string, body: Record<string, unknown>): StepObservation =>
  ({ id, status: 200, headers: {}, body }) as unknown as StepObservation;

describe("calibrating against the old build", () => {
  it("marks a value the build did not reproduce", () => {
    const paths = volatilePaths(
      [step("create", { id: "a_1", amount: 100 })],
      [step("create", { id: "a_2", amount: 100 })],
    );
    expect(paths.has("create/id")).toBe(true);
    expect(paths.has("create/amount")).toBe(false);
  });

  it("marks a value that appeared in only one run", () => {
    const paths = volatilePaths(
      [step("create", { id: "a" })],
      [step("create", { id: "a", extra: 1 })],
    );
    expect(paths.has("create/extra")).toBe(true);
  });

  it("refuses when the two runs answered a different number of steps", () => {
    // The old behaviour returned a partial calibration, which is worse than
    // none: the caller cannot tell that some steps were never calibrated.
    expect(() =>
      volatilePaths(
        [step("create", { created: 1 }), step("retrieve", { created: 1 })],
        [step("create", { created: 2 })],
      ),
    ).toThrow(CalibrationError);
    expect(() => volatilePaths([step("a", {}), step("b", {})], [step("a", {})])).toThrow(
      /answered 2 steps and then 1/,
    );
  });

  it("is happy when both runs are identical, which means nothing is volatile", () => {
    expect(volatilePaths([step("a", { x: 1 })], [step("a", { x: 1 })]).size).toBe(0);
  });
});
