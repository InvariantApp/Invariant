/**
 * The golden vectors for success statuses answered as another: what a site's
 * status rules mean, stated as data so another engine can be held to it.
 *
 * Each case is a site's rules and any work it does on the body, what the
 * provider answered an old caller's request with, and what the caller has
 * to be answered, or `decode` where the program itself must be refused. Only
 * the headers a case names are compared: `headers` must be present with those
 * values, and `absent` must not be present at all, so an engine's own
 * bookkeeping (a date, a contract header) never decides a case.
 */
import type { Instr, StatusRule } from "@invariant-app/ir";

export interface StatusAnswer {
  status: number;
  headers: [string, string][];
  /** The body, where there is one; none and an empty one are the same answer. */
  body?: string;
}

export interface StatusVector {
  name: string;
  why: string;
  /** The site of `post /v`: its rules, and any work on a body, keyed by the provider's status. */
  site: { status: StatusRule[]; response?: Record<string, Instr[]> };
  /** What the provider answered. */
  answer: StatusAnswer;
  expect:
    | {
        answer: StatusAnswer;
        /** Headers that must not be sent. */
        absent?: string[];
      }
    | { refuses: "decode" };
}

const C = "chg_vector";
const JSON_TYPE: [string, string] = ["content-type", "application/json"];

export const STATUS_VECTORS: StatusVector[] = [
  {
    name: "a status is answered as the one the old contract promised, without a body it never promised",
    why: "Gitea 1.25 answers 201 with the variable it created where 1.24 answered 204 with nothing; an old caller checks for 204.",
    site: { status: [{ from: 201, to: 204, empty: true, c: C }] },
    answer: { status: 201, headers: [JSON_TYPE], body: '{"name":"CI"}' },
    expect: {
      answer: { status: 204, headers: [] },
      absent: ["content-type", "content-length"],
    },
  },
  {
    name: "a status promised with no body is answered with an empty one of length zero",
    why: "Immich 1.138 answers 204 where 1.137 answered 200 with nothing, and a 200 says how long its body is.",
    site: { status: [{ from: 204, to: 200, empty: true, c: C }] },
    answer: { status: 204, headers: [] },
    expect: {
      answer: { status: 200, headers: [["content-length", "0"]] },
      absent: ["content-type"],
    },
  },
  {
    name: "a body both statuses carry is served as any body is, with the work for the provider's status",
    why: "The rest of the release's Changes are filed under the status the provider answers with, which is the one an engine reads.",
    site: {
      status: [{ from: 201, to: 200, c: C }],
      response: { "201": [{ k: "move", from: "/amount_cents", to: "/amount", c: C }] },
    },
    answer: { status: 201, headers: [JSON_TYPE], body: '{"amount_cents":5}' },
    expect: {
      answer: {
        status: 200,
        headers: [JSON_TYPE, ["content-length", "12"]],
        body: '{"amount":5}',
      },
    },
  },
  {
    name: "rules apply in turn, each to the status the one before answered",
    why: "A chain of releases is one list: the later release's rule first, then the earlier one's, as a response undoes the later release first.",
    site: {
      status: [
        { from: 202, to: 201, c: C },
        { from: 201, to: 204, empty: true, c: "chg_earlier" },
      ],
    },
    answer: { status: 202, headers: [JSON_TYPE], body: '{"id":1}' },
    expect: { answer: { status: 204, headers: [] }, absent: ["content-type"] },
  },
  {
    name: "a status no rule names is answered as it came",
    why: "A rule is about one status; every other answer of the operation is the provider's.",
    site: { status: [{ from: 201, to: 204, empty: true, c: C }] },
    answer: { status: 200, headers: [JSON_TYPE], body: '{"id":1}' },
    expect: { answer: { status: 200, headers: [JSON_TYPE], body: '{"id":1}' } },
  },
  {
    name: "a rule that would send a body with a 204 is refused",
    why: "A 204 never carries a body, so a program that says otherwise was not compiled by anyone who read it.",
    site: { status: [{ from: 201, to: 204, c: C }] },
    answer: { status: 201, headers: [] },
    expect: { refuses: "decode" },
  },
  {
    name: "a rule that answers a status as itself is refused",
    why: "It says nothing, and a program that says nothing where it claims to is refused rather than trusted.",
    site: { status: [{ from: 201, to: 201, c: C }] },
    answer: { status: 201, headers: [] },
    expect: { refuses: "decode" },
  },
  {
    name: "a rule that answers with a status that is not a success is refused",
    why: "Only a success status an old caller was promised is ever answered in place of another.",
    site: { status: [{ from: 201, to: 302, c: C }] },
    answer: { status: 201, headers: [] },
    expect: { refuses: "decode" },
  },
];
