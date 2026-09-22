/**
 * The golden vectors for form-encoded bodies: a site's form declaration, its
 * instructions, a body as a caller sends it, and the body that has to come
 * out, or the change that has to refuse it.
 */
import type { FormProgram, Instr } from "@invariant-app/ir";

export interface FormVector {
  name: string;
  why: string;
  form: FormProgram;
  instrs: Instr[];
  input: string;
  expect: { output: string } | { refuses: string };
}

const C = "chg_vector";
const deep = { style: "deepObject" as const, explode: true };

export const FORM_VECTORS: FormVector[] = [
  {
    name: "a nested field is renamed in bracketed keys",
    why: "Stripe writes nested fields as `metadata[order]=`, and a rename inside one is the commonest nested change.",
    form: { fields: { metadata: deep }, types: {} },
    instrs: [{ k: "move", from: "/metadata/order", to: "/metadata/order_id", c: C }],
    input: "amount=100&metadata[order]=6735&currency=usd",
    expect: { output: "amount=100&currency=usd&metadata[order_id]=6735" },
  },
  {
    name: "a pair no instruction names keeps its exact bytes",
    why: "Re-encoding what no Change named would change bytes someone may depend on, for no reason.",
    form: { fields: {}, types: { "/amount": "number" } },
    instrs: [{ k: "scale", path: "/amount", exp: 2, c: C }],
    input: "description=a+b%21&amount=1.5",
    expect: { output: "description=a+b%21&amount=150" },
  },
  {
    name: "a field in every element of a list is renamed",
    why: "Stripe writes lists of objects as `items[0][price]=`, and the wildcard has to reach each one.",
    form: { fields: { items: deep }, types: {} },
    instrs: [{ k: "move", from: "/items/*/price", to: "/items/*/price_id", c: C }],
    input: "items[0][price]=p_1&items[1][price]=p_2&mode=payment",
    expect: { output: "mode=payment&items[0][price_id]=p_1&items[1][price_id]=p_2" },
  },
  {
    name: "a repeated plain field is renamed and stays repeated",
    why: "Twilio writes a list as the same key repeated, with no brackets.",
    form: { fields: {}, types: { "/StatusCallbackEvent": "array" } },
    instrs: [{ k: "move", from: "/StatusCallbackEvent", to: "/StatusEvents", c: C }],
    input: "To=%2B15551234&StatusCallbackEvent=initiated&StatusCallbackEvent=ringing",
    expect: { output: "To=%2B15551234&StatusEvents=initiated&StatusEvents=ringing" },
  },
  {
    name: "a plain field's value is mapped",
    why: "An enum rename is the same instruction in a form as in JSON.",
    form: { fields: {}, types: {} },
    instrs: [{ k: "enum", path: "/Status", map: { queued: "accepted" }, c: C }],
    input: "Status=queued&Body=hello",
    expect: { output: "Body=hello&Status=accepted" },
  },
  {
    name: "a newly required field is supplied",
    why: "A default an old caller never sent, without overwriting one they did.",
    form: { fields: {}, types: {} },
    instrs: [
      { k: "set", path: "/capture_method", value: "automatic", ifAbsent: true, c: C },
    ],
    input: "amount=100",
    expect: { output: "amount=100&capture_method=automatic" },
  },
  {
    name: "a null is written as an empty value",
    why: "An empty value is how a form says unset, which is what Stripe reads it as.",
    form: { fields: {}, types: {} },
    instrs: [{ k: "set", path: "/description", value: null, ifAbsent: false, c: C }],
    input: "description=old",
    expect: { output: "description=" },
  },
  {
    name: "a prototype key inside a bracketed field is dropped",
    why: "Keys inside brackets are the caller's to choose, and `__proto__` must never become one.",
    form: { fields: { metadata: deep, meta: deep }, types: {} },
    instrs: [{ k: "move", from: "/metadata", to: "/meta", c: C }],
    input: "metadata[__proto__][x]=1&metadata[a]=1",
    expect: { output: "meta[a]=1" },
  },
  {
    name: "a value a number was declared for, written as text, is refused by the scale",
    why: "The form carries text; typing it is what lets a scale refuse what is not a number.",
    form: { fields: {}, types: { "/amount": "number" } },
    instrs: [{ k: "scale", path: "/amount", exp: 2, c: C }],
    input: "amount=abc",
    expect: { refuses: C },
  },
  {
    name: "a declaration naming a prototype key is refused",
    why: "A program is data from a build, and a build can be wrong.",
    // Built as a program file would carry it: in an object literal
    // `__proto__` sets the prototype instead of naming a field.
    form: {
      fields: JSON.parse('{"__proto__":{"style":"deepObject","explode":true}}'),
      types: {},
    },
    instrs: [{ k: "del", path: "/x", c: C }],
    input: "x=1",
    expect: { refuses: "decode" },
  },
];
