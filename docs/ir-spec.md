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

Thirteen ops. The catalog is closed, and that is the point: a closed catalog is
what makes "this change cannot be expressed" a machine-detectable state rather
than a judgement call.

| Op | Forward, on a request | Backward, on a response |
|---|---|---|
| `move {from, to}` | relocate a value between pointers | the inverse move |
| `convert {path, codec}` | apply the codec forward | apply it backward |
| `add {path, value}` | insert `value` when the field is absent | delete the field |
| `remove {path, restore?}` | delete the field | set it to `restore`; without one, nothing |
| `default {path, value, when, toward}` | toward the new contract, fill a missing or null value | toward the old contract, fill a missing or null value |
| `dropNull {path, toward}` | toward the new contract, delete a null | toward the old contract, delete a null |
| `widen {path, variant, show}` | nothing | show a union's new kind of object as its id, left out, or null |
| `relax {path, set}` | nothing | nothing; the new bounds are a declared loss |
| `restate {path}` | nothing | nothing; proved to be the same values |
| `route {from, to}` | rewrite method and path | nothing; responses are keyed by the resolved operation |
| `retire {endpoint}` | refuse with the provider's guidance | nothing |
| `status {endpoint, from, to}` | nothing | answer `from` where the operation now answers `to`, with no body where the old contract promised none |
| `behavior {flag, covers?}` | nothing | nothing |

`remove` without a `restore` leaves the field out of old callers' responses,
which is only right where they were never promised it: a field only requests
carry, or one their contract made optional. The compiler refuses it on a
response field their contract required, because only a value put back serves
them there.

`relax` states how a value's bounds moved: a maximum raised, a pattern or
format dropped, and, on a response, values an enum no longer holds. Nothing is
transformed. A response that may now carry a value outside the old bounds is a
declared loss the provider acknowledges, and so is one that will never again
carry a value an old caller may wait for. A bound that narrows on something old
callers send is refused, since they would be turned away for what their
contract allowed, and so is an enum that grows: a value old callers never
heard of has to be shown to them as one they know, which is a `convert` with a
fold, decided by a person.

Two settings say the new contract stopped stating something at all. `enum:
null` is a field whose values were listed and now are not, such as a model name
that became any string: there is nothing to fold a new value onto, so it passes
through, declared. A field that became a choice between the values it listed
and any other text says the same, and is that `relax` followed by a `restate`
that writes the choice as the new contract does. `type: null` is a value that was typed and now is not. A
type changed to another type is a `convert`, never this. `type` may instead
list the types a value may now be, where every type it was is among them, as
Okta's user schema attributes came to list an enum's values as text or whole
numbers: it is written as a choice of those types, a declared loss wherever
old callers are sent it, and a `restate` that follows writes the choice as the
new contract does. A list that leaves out a type the value was is refused.

`restate` says the new contract describes the same values another way:
properties that became a `oneOf` of the shapes they were always sent in, a
schema split into named variants, a list of values written as a `const` per
branch. Nothing is transformed, and nothing is lost, so the Change stays exact;
that is only true because the compiler proves it, schema against schema. Where
old callers are answered with the value, every value the new schema admits must
be one the old schema admitted; where they send it, every value the old schema
admitted must be one the new schema accepts. Both proofs rest on one
assumption, stated here once: a property neither schema declares is never
sent, so a closed `additionalProperties` and an open one describe the same
values. Because of that assumption containment cannot tell a renamed
optional field from one that was always absent, so a restatement must also
keep every property name the old schema declares under the place, in some
branch if the new schema is a choice: what may change is how the values are
written, never which names carry them. A `discriminator` names a property
every branch carries, as OpenAPI requires. An `int32` or `int64` format is the
range of whole numbers it holds, so a page size bounded to 1 and 1000 that
comes to state `int64` is the same values; any other format is kept only where
both schemas state it. A restatement the proof cannot show is refused, naming the place and
the reason, and is then a `relax`, which declares the difference, or a
`convert`, which translates it.

`move` covers rename, nest and unnest, because all three are the same
operation on a pointer. A move whose source is absent does nothing; it must not
create the target as null.

`status` says an operation answers with another success status: Gitea 1.25
answers the creation of an Actions variable `201` where 1.24 answered `204`,
and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. The
endpoint is named as the old contract names it, and both statuses are exact
codes from 200 to 299. An old caller is answered `from` wherever the operation
now answers `to`. What happens to the body is read from the two contracts:
where the old contract promised none with `from`, none is sent, whatever the
provider sent with `to`; where it promised one and `to` carries one, the body
is served as any body is, by the release's other Changes, which are filed
under `to`. Where it promised one and `to` carries none, nothing can stand in
for it, and the compiler refuses the Change, as it does one whose new contract
still answers `from` or does not answer `to`. The Change stays exact: an old
caller is answered as its contract promised, and is shown nothing it was not.

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

The codec catalog is closed too: `scale10`, `enumMap`, `cast`, `dateFormat`,
`stringCase`, `wrapArray`, `unwrapSingle`, `dropValues`. There are no
expressions and no
conditionals. Every codec is exact or refuses, unless the Change declares a
loss by name, and a declared loss makes the Change `declared-lossy`.

- **`scale10 {exponent, onInexact: reject}`** moves the decimal point by
  `exponent` places. It must be done on the decimal text, never by multiplying:
  `19.99 * 100` is `1998.9999999999998` in binary floating point. A value that
  cannot be represented exactly after the shift is **refused**, not rounded.
- **`enumMap {pairs}`** maps values one to one. A value with no mapping is
  **refused**, unless the instruction is marked lenient (see below). Two old
  values may be declared to become one, which is how a value the new contract
  no longer accepts is sent as one it keeps; that is declared-lossy, and on
  the way back the value that remains is shown as itself, since the API can
  no longer produce the one that went.
- **`cast {from, to}`** between `string`, `integer`, `number` and `boolean`.
- **`dateFormat {from, to, onInexact?}`** between `epoch-s`, `epoch-ms` and
  `rfc3339`: the same instant, written another way. Text is always written in
  UTC as `YYYY-MM-DDTHH:MM:SS[.sss]Z`, with the three-digit fraction only when
  it is not zero. Dates are proleptic Gregorian, computed from the civil
  calendar rather than a host date library, for years 0000 to 9999. A leap
  second, a day that does not exist, a year outside that range, and precision
  the target cannot hold are **refused**. With `onInexact: truncate` the
  precision is dropped instead, toward the earlier instant (-0.5 s is -1),
  and the Change is declared-lossy. An offset an old caller wrote does not
  survive a count since the epoch; the instant does, and the compiler
  declares the offset as the loss.
- **`stringCase {from, to}`** between `snake`, `screaming`, `kebab`, `camel`
  and `pascal`. Words are runs of `[a-z0-9]`; in camel and pascal case a
  capital starts one. Text not written in `from`, an acronym (two capitals
  together), and text whose words the target cannot keep apart are
  **refused**. The check is the round trip itself: convert, read back, and
  refuse unless the original comes out.
- **`wrapArray {pick?}`**: a value became a list of what it was. Forward
  wraps. Backward shows one item: with `pick: only`, the default, a list of
  any length but one is **refused**; with `pick: first`, the first item is
  shown and an empty list leaves the field out, which is declared-lossy.
- **`unwrapSingle {pick?}`**: the inverse, a list that became one value.
- **`dropValues {values}`**: values a list's items may hold on one side and
  not the other. Each is left out of the list on its way to the side whose
  contract does not name it, and the rest is kept in order: forward, what an
  old caller asks for that the new contract no longer accepts; backward, what
  the API now sends that the old contract never named. A single value where a
  list belongs is **refused**. The compiler reads which values are which from
  the old contract's list: one it held is taken out of the predicted list, and
  one it did not is added. Always declared-lossy: the caller asked for
  something it will not get, or is not told something the API sent. A single
  value that is gone is an `enumMap` to one that remains, and a single new
  one a fold, never this.

A null passes through every codec unchanged, so a nullable field stays
nullable on both sides.

---

## 3. Scopes and pointers

A scope names a schema in the **old** contract. The compiler finds every place
that schema reaches the wire by walking `$ref` usage, so one statement covers a
create body, a retrieve response and every element of a list envelope.

A Change may instead be scoped to one operation's request parameters or to one
operation's response at one status. That is what a body written in place needs,
since it has no name, and what an operation whose response now names a
different schema needs, since the schema the rest of the API shares did not
change.

Pointers are JSON Pointer with two additions: a `*` segment matches every
element of an array, and a `{}` segment matches every value of an object used
as a map (`additionalProperties`). Nothing else. A pointer naming `__proto__`, `constructor`
or `prototype` is refused at decode time, before any program can load.

---

## 4. The compiled program

The runtime never sees a Change, a scope or a direction. It sees an ordered
list of primitives per site, already inverted where inversion was needed.

```json
{
  "irVersion": 2,
  "compiledBy": "@invariant-app/compiler@0.1.0",
  "minRuntime": "0.1.0",
  "api": "acme-payments",
  "current": "sha256:...",
  "currentLabel": "2026-09-20",
  "identity": [{ "kind": "header", "name": "acme-version" },
               { "kind": "default", "label": "2026-01-15" }],
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

### Versions

`irVersion` is the program format, 2 since long chains were linked through
shared blocks and every program began to say what it needs. It is raised only
for a change an older engine would misread rather than refuse.

`minRuntime` is the oldest runtime that runs everything the program uses,
worked out from the features it actually contains, so a program that uses
nothing new keeps running on runtimes older than the compiler that built it.
`compiledBy` records the compiler release, for whoever reads the program
later, and is left out of the program's digest: two releases that write the
same instructions have written the same program.

An engine reads both before anything else in the program, and refuses a
program it is too old for with a typed error naming the runtime it needs. It
never runs part of a program: an instruction skipped because it was not
understood is a response in a shape nobody promised.

### Identity

`identity` is how a request names the contract it expects, tried in order,
first match wins: a `header` by name, compared lower-cased; a `urlPrefix`
mapping path prefixes to labels; `principal`, the contract an account was
pinned to, known only after the provider authenticates the caller; and a
`default` label. It is declared once, in `invariant.yaml`, and compiled in, so
every binding and the proxy read the same list. An engine may take a list
given to it explicitly instead, and must refuse to start with neither.

### Instructions

| `k` | Fields | Meaning |
|---|---|---|
| `move` | `from`, `to` | relocate; prune an emptied parent; do nothing if absent |
| `scale` | `path`, `exp` | shift the decimal point; refuse if inexact |
| `enum` | `path`, `map`, `lenient?` | map a value; refuse an unmapped one unless lenient |
| `cast` | `path`, `to` | change the scalar type |
| `time` | `path`, `from`, `to`, `truncate?` | re-encode an instant, as `dateFormat` |
| `case` | `path`, `from`, `to` | rewrite an identifier's case, as `stringCase` |
| `wrap` | `path` | put the value in a list of one |
| `unwrap` | `path`, `first?` | take the one item out of a list; refuse any other length unless `first` |
| `set` | `path`, `value`, `ifAbsent`, `ifNull?` | write a value; `ifAbsent` must not overwrite |
| `del` | `path`, `ifNull?` | remove a field, or only a null one |
| `within` | `path`, `block` | run the block at each match, its pointers read from there; a match need not be an object, and an empty path in the block names the match itself |
| `switch` | `path`, `cases` | run the block for the value a key holds, read once on entry |
| `has` | `path`, `block`, `absent?` | run the block where a field is present, or missing |
| `is` | `path`, `type`, `block` | run the block where the value is of one JSON kind |
| `call` | `block` | run a named block, the contract's own or the program's, where it stands |

Every instruction carries `c`, the id of the Change it came from, so one change
can be counted and switched off on its own.

### Statuses

A site may carry `status`, a list of rules `{from, to, empty?, c}`, each a
success status from 200 to 299: where the provider answered `from`, the
caller is answered `to`. They apply in turn to the status the provider
answered, each to the status the one before gave, so a chain of releases is
one list, the later release's rules first. `empty` sends the answer without a
body and without the headers that describe one, where the caller's contract
promised none; a `204` or a `205` is always sent without one. A `200` sent
empty says its length is zero. The site's `response` work is keyed by the
status the provider answered, before any rule, and does not run for an answer
sent empty.

`lenient` exists for exactly one case: a field naming another field, such as the
`param` in a validation error. An unfamiliar name there is harmless; failing the
whole response over it is not.

### XML bodies

A site may carry `xml`, for a body its operation declares as XML
(`application/xml`, `text/xml` or anything `+xml`): `request`, and
`response` keyed as the site's `response` work is. Each is `{read, write}`,
two descriptions of the body: how the one the instructions run on is
written, and how the places they write are to be written. A request is read
as the caller's contract writes it and written as the current one does; a
response the other way round. The instructions are the same ones a JSON body
runs; the body is decoded into a tree, they run, and it is written back.

A description is a tree of nodes, each `{type, name?, namespace?, prefix?,
attribute?, wrapped?, properties?, items?}`, from the schema's OpenAPI `xml`
object, for the places the instructions reach and the elements on the way:

- An object's `properties` are its fields, each an element named `name`, or
  the field's own name, or with `attribute` an attribute of it.
- A list is its items repeated in place, each named `items.name`, or with
  `wrapped` inside an element named `name`.
- `type` is what the place holds, so text reaches an instruction typed:
  `integer`, `number` or `boolean` text that reads as one becomes one, and
  anything else stays text. `any` is a place no instruction reads by value,
  moved or removed whole as it came.
- With `namespace`, an element matches only in that namespace; without one,
  in whatever namespace the document puts it. An attribute without one
  matches only when it has none.

The root element is kept whatever its name. Every element no node names is
kept exactly as it came, bytes and all, wherever its parent goes, and so is
everything between elements. A value an instruction left as it was is written
back as it came, references and all, so a document nothing changed comes out
byte for byte. A field the program adds is written before the white space
that indents its parent's end tag; an element written under a new name keeps
its attributes and contents, and takes along any namespace declaration the
place it lands lacks. Text a program writes is escaped.

The parser reads XML 1.0 with namespaces, in UTF-8, and nothing else: a
document type declaration is refused outright, so there are no entities but
XML's five and character references, nothing external is read and nothing
expands; an encoding or a charset other than UTF-8, a character XML does not
allow, text among an object's elements, attributes on a value the description
calls text, a field written twice where the description has one, and
anything not well formed are refused, as a body that is not JSON is. Nesting
is capped as a JSON body's is.

### What the provider sends

A contract may carry `outbound`, keyed `method webhook:<name>` for an entry
under `webhooks` and `method callback:<operation>/<callback>` for one under an
operation's `callbacks`. Each is a list of instructions run on a payload the
provider is about to send, to put it in the shape a subscriber on that
contract expects, in the same direction as a response. It runs before the
payload is signed, because a subscriber verifies the signature over the bytes
it receives. An event with no entry is sent as it is.

### Ordering

Instructions apply in the order given. A rename followed by a conversion
targets the **new** name. Applying them in any other order finds nothing and
silently does half the work.

### Chaining

A consumer several contracts behind is served by one program, not by several
run in sequence. Requests run chronologically; responses run in reverse. A
step files its work under the endpoint the request has **arrived at**, because
path rewriting happens before routing and body rewriting after it.

Contract N's work at a site is its own step and then contract N+1's work at
the same site. Written out, every contract would repeat every later step and
a program would grow with the square of its history, so a compiler links them
instead: contract N+1's lists go into blocks at the top of the program, under
`blocks`, and contract N ends its request list with a `call` to one (begins
its response list, for a response). Blocks are named for what they hold, so
sites that do the same work share one. A contract's `blocks` and the
program's share one namespace; a name declared in both is refused at load.
An engine runs a linked program exactly as it would the program written out
in full, and the chain equivalence check holds the compiler to that.

---

## 5. What an engine must refuse

A refusal is as much part of this contract as a result. An engine that quietly
rounds where this one rejects is not compatible; it is dangerous.

- A `scale` that cannot be represented exactly.
- An `enum` value with no mapping, unless lenient.
- A `time` value that is not an instant its source format can write, or one
  the target cannot hold, unless `truncate`.
- A `case` value not written in its source case, or one that does not survive
  the round trip.
- An `unwrap` of a list that does not hold exactly one item, unless `first`.
- A program containing a pointer with a prototype key, at decode time.
- A program in a newer format, or asking for a newer runtime, at load, before
  any of it is read.
- A program with an instruction, key or feature it does not know, at load.
- A status rule outside 200 to 299, one that answers a status as itself, or
  one that answers a `204` or `205` without `empty`, at load.
- A body larger than the configured cap, on a site that has work to do.
- An XML body that is not well formed, declares a document type, is not
  UTF-8, or holds what its description cannot carry back exactly (see
  XML bodies); a null or a list of lists written into one; and, at load, a
  description with a list of lists, two fields written as one element, or an
  instruction reaching a map's values in an XML body.

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

`conformance/vectors.json` holds cases as data: 75 over bodies, 22 over whole
requests, 10 over form-encoded bodies, 8 over success statuses and 54 over XML
bodies, each a program, an input, and either an expected output or the
refusal that must happen. 22 of the body cases and 18 of the XML ones are
refusals. An engine claiming to run this IR must reproduce all of them.

The file is generated from the same source the reference engine is tested
against, and the build fails if the two drift, because a port certified against
a stale file is certified against nothing.
