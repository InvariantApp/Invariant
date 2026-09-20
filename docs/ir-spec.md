# The Change IR

This is the normative description of the intermediate representation. It is
written so an engine in another language can be built from it without reading
the TypeScript, and paired with `conformance/vectors.json`, which is the same
contract as data.

Where this document and the vectors disagree, the vectors are right.

---

## 1. What a Change is

One typed, bidirectional statement about something a provider altered between
two contracts. It is written once, in the pull request that makes the change,
and everything downstream is a projection of it: the request transform, the
response transform, the predicted specification used to check it, and the
codemods handed to consumers.

Ops are written in old-to-new order. Applying them in order is the forward
direction. Applying their inverses in reverse order is the backward direction.
That is the whole execution model.

```yaml
irVersion: 1
id: chg_money_in_minor_units
summary: Money crosses the wire in minor units.
scopes:
  - schema: "#/components/schemas/Payment"
ops:
  - op: move
    from: /amount
    to: /amount_cents
  - op: convert
    path: /amount_cents
    codec: { kind: scale10, exponent: 2, onInexact: reject }
assertions:
  same_concept: true
  side_effects_unchanged: true
```

Unknown fields and unknown op kinds are hard errors. There is no lenient mode:
a document the compiler does not fully understand must never reach a request
path.

---

## 2. The op catalog

Six ops. The catalog is closed, and that is the point: a closed catalog is what
makes "this change cannot be expressed" a machine-detectable state rather than
a judgement call.

| Op | Forward, on a request | Backward, on a response |
|---|---|---|
| `move {from, to}` | relocate a value between pointers | the inverse move |
| `convert {path, codec}` | apply the codec forward | apply it backward |
| `add {path, value}` | insert `value` when the field is absent | delete the field |
| `remove {path, restore}` | delete the field | set it to `restore` |
| `route {from, to}` | rewrite method and path | nothing; responses are keyed by the resolved operation |
| `behavior {flag, covers?}` | nothing | nothing |

`move` covers rename, nest and unnest, because all three are the same
operation on a pointer. A move whose source is absent does nothing; it must not
create the target as null.

`behavior` has no transform at all. It records that provider code branches on
contract age, which is the honest answer when a change is not about shape. A
Change containing one is derived as `runtime: none` and cannot be served.

At runtime the branch is reached through `before(flag, { contract })`, which
answers whether this caller predates the change the flag marks. Asking about a
flag no Change declares throws, because answering `false` would silently give
every old caller the new behaviour, which is the one outcome the flag exists to
prevent. A flag only ever selects a shape or a code path; it must never decide
what a caller is permitted to do, since the caller chooses their own label.

`covers` is how a `behavior` Change accounts for breaking deltas without
transforming them. Each entry is one delta, written exactly as the release gate
prints it. It is a list rather than a wildcard, and the gate refuses a release
whose real unexplained deltas differ from the list in either direction: one
nobody claimed, or a claim for something that no longer happens. Either means
the contract moved underneath an acknowledgement. A release carrying a covered
delta warns; it never passes.

### Codecs

The codec catalog is closed too: `scale10`, `enumMap`, `cast`. There are no
expressions and no conditionals.

- **`scale10 {exponent, onInexact: reject}`** moves the decimal point by
  `exponent` places. It must be done on the decimal text, never by multiplying:
  `19.99 * 100` is `1998.9999999999998` in binary floating point. A value that
  cannot be represented exactly after the shift is **refused**, not rounded.
- **`enumMap {pairs}`** maps values one to one. Must be bijective in version 1.
  A value with no mapping is **refused**, unless the instruction is marked
  lenient (see below).
- **`cast {from, to}`** between `string`, `integer`, `number` and `boolean`.

---

## 3. Scopes and pointers

A scope names a schema in the **old** contract. The compiler finds every place
that schema reaches the wire by walking `$ref` usage, so one statement covers a
create body, a retrieve response and every element of a list envelope.

Pointers are JSON Pointer with one addition: a `*` segment matches every
element of an array. Nothing else. A pointer naming `__proto__`, `constructor`
or `prototype` is refused at decode time, before any program can load.

---

## 4. The compiled program

The runtime never sees a Change, a scope or a direction. It sees an ordered
list of primitives per site, already inverted where inversion was needed.

```json
{
  "irVersion": 1,
  "api": "acme-payments",
  "current": "sha256:...",
  "currentLabel": "2026-09-20",
  "contracts": {
    "2026-01-15": {
      "label": "2026-01-15",
      "routes": [{ "from": {"method":"post","path":"/v1/charges"},
                   "to":   {"method":"post","path":"/v1/payments"}, "c": "chg_..." }],
      "sites": {
        "post /v1/payments": {
          "request":  [{"k":"move","from":"/amount","to":"/amount_cents","c":"chg_..."},
                       {"k":"scale","path":"/amount_cents","exp":2,"c":"chg_..."}],
          "response": { "201": [ ... ] }
        }
      },
      "behaviors": []
    }
  }
}
```

### Instructions

| `k` | Fields | Meaning |
|---|---|---|
| `move` | `from`, `to` | relocate; prune an emptied parent; do nothing if absent |
| `scale` | `path`, `exp` | shift the decimal point; refuse if inexact |
| `enum` | `path`, `map`, `lenient?` | map a value; refuse an unmapped one unless lenient |
| `cast` | `path`, `to` | change the scalar type |
| `set` | `path`, `value`, `ifAbsent` | write a value; `ifAbsent` must not overwrite |
| `del` | `path` | remove a field |

Every instruction carries `c`, the id of the Change it came from, so one change
can be counted and switched off on its own.

`lenient` exists for exactly one case: a field naming another field, such as the
`param` in a validation error. An unfamiliar name there is harmless; failing the
whole response over it is not.

### Ordering

Instructions apply in the order given. A rename followed by a conversion
targets the **new** name. Applying them in any other order finds nothing and
silently does half the work.

### Chaining

A consumer several contracts behind is served by one concatenated program, not
by several run in sequence. Requests concatenate chronologically; responses
concatenate in reverse. A step files its work under the endpoint the request
has **arrived at**, because path rewriting happens before routing and body
rewriting after it.

---

## 5. What an engine must refuse

A refusal is as much part of this contract as a result. An engine that quietly
rounds where this one rejects is not compatible; it is dangerous.

- A `scale` that cannot be represented exactly.
- An `enum` value with no mapping, unless lenient.
- A program containing a pointer with a prototype key, at decode time.
- A body larger than the configured cap, on a site that has work to do.

On a request, a refusal happens **before** the handler, so there is no side
effect. On a response, the canonical body is never emitted in the wrong shape.

---

## 6. Two stages, and why

Path rewriting must happen **before** routing, so an old URL reaches the
canonical handler at all. Body rewriting must happen **after** authentication,
so a signature computed over the bytes the client sent is verified against
those bytes. Putting both in one place breaks one of the two.

---

## 7. What this cannot express

Stated because a closed catalog is only useful if its edges are known.

Splitting one field into two or merging two into one. Reshaping `oneOf`,
`anyOf` or a discriminator. Values derived from an external lookup. The
contents of an opaque cursor. Authentication scheme changes. Multipart, binary
and streaming bodies. Non-bijective value maps on a request path.

Each of these makes the compiler report `none`, and the release gate blocks
until a `behavior` Change names the specific deltas in `covers` and provider
code handles them. That is the whole of the escape hatch: it costs an explicit
line per delta, it is re-checked on every release, and it downgrades the result
to a warning rather than clearing it.

---

## 8. Conformance

`conformance/vectors.json` holds twenty cases as data: a program, an input, and
either an expected output or the refusal that must happen. Three of them are
refusals. An engine claiming to run this IR must reproduce all of them.

The file is generated from the same source the reference engine is tested
against, and the build fails if the two drift, because a port certified against
a stale file is certified against nothing.
