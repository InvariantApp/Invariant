/**
 * What every language pack shares.
 *
 * A pack reads one language: it finds the references a Change touches, says
 * what role each plays, and writes edits. What the Changes mean for an SDK's
 * symbols, how edits compose and how a site is reported to a person are the
 * same in every language, and live here, so a fourth language is a pack and
 * not a fork of the first.
 */

export * from "./describe.ts";
export * from "./edits.ts";
export * from "./offsets.ts";
export * from "./plan.ts";
export type { ManualSite } from "./sites.ts";
export * from "./tagged.ts";
