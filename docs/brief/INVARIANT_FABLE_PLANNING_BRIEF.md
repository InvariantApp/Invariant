# Invariant — Fable 5.1 High Planning Brief
## Self-Maintaining APIs as API Evolution Infrastructure

**Status:** Planning handoff  
**Audience:** Fable 5.1 High / senior systems-design planning pass  
**Date:** 2026-09-20  
**Working name:** Invariant  
**Primary task:** Produce a build-ready, professional engineering plan for the MVP and its scalable architecture. Do **not** blindly accept this document's proposed implementation details. Audit them, improve them, simplify them, and replace them where a more elegant or feasible design exists.

---

# 0. Instructions to Fable

You are planning a serious infrastructure product, not a demo wrapper around an LLM.

Your job is to take the product thesis and constraints in this document and produce a **professional engineer-level system design and implementation plan that can be handed directly to a coding agent and built phase by phase**.

You must:

1. **Audit every architectural assumption in this document.**
   - Do not preserve an idea just because it appears here.
   - Look for a smaller, more powerful primitive that collapses components.
   - Look for hidden impossibilities, trust problems, latency problems, ambiguous ownership, unsafe automation, and operational complexity.
   - Explicitly call out anything that sounds elegant conceptually but is impractical technically.

2. **Push toward elegance.**
   - Minimize concepts, network hops, state duplication, and bespoke infrastructure.
   - Prefer one canonical representation of an API change that can drive multiple outputs.
   - Prefer deterministic mechanisms over agents where deterministic mechanisms are sufficient.
   - Prefer intelligence at compile/release time over intelligence in the API request hot path.
   - Avoid building a giant platform before the core primitive is proven.

3. **Push toward feasibility.**
   - The first version must be buildable by a small startup team.
   - The architecture should have a credible path to production scale without requiring the MVP to solve every enterprise deployment model.
   - Scope the MVP aggressively while preserving the core magic.

4. **Use Jev only where it creates a real structural advantage.**
   - Do not insert Jev because the project wants to use Jev.
   - Benchmark/compare Jev's role against deterministic rules and System 2 reasoning.
   - Jev should generally be used for fast, typed semantic judgments, classification, entity alignment, confidence/risk decisions, and routing—not arbitrary code generation.
   - There should be **no model inference in the API request hot path** unless you can make an exceptional, rigorously justified case.

5. **Do not wrap or depend on Relay.**
   - There is an existing conceptual project called Relay that performs blast-radius analysis and migration PR generation.
   - **Treat Relay only as evidence that this workflow is useful.**
   - Do **not** reuse Relay's code, architecture, data model, packages, repo, naming, or assumptions.
   - Rebuild the consumer impact/migration capability natively for Invariant around Invariant's own contract model, Semantic IR, and API Evolution Bundle.
   - The new migration engine should be materially better because it receives provider-authored/provider-confirmed semantic change information instead of rediscovering intent from changelogs after the fact.

6. **Do external research before freezing the plan.**
   - Read the sources in the research section.
   - Check the current competitive landscape.
   - Check the latest Jev SDK/API and TypeSafe patterns.
   - Check current OpenAPI/Overlay, API diff, gateway/proxy, and schema-evolution tooling.
   - Search for products or open-source systems that already implement any part of the architecture.
   - If a component can be built safely on a mature open-source primitive, prefer that to recreating infrastructure.

7. **Resolve decisions.**
   - The final plan must not end as a list of "we could use X or Y."
   - Investigate alternatives, compare them, then choose the MVP approach.
   - Record rejected alternatives and why.
   - Choose the language(s), storage, queue/event model if needed, API shape, runtime deployment approach, repository structure, critical libraries, test strategy, and deployment model.

8. **Design for buildability after planning.**
   - Define phases with concrete acceptance tests.
   - Define module boundaries and interfaces.
   - Define key schemas.
   - Define what data is persisted and what is ephemeral.
   - Define failure modes and rollback semantics.
   - Define a local end-to-end development fixture.
   - Define exactly how the first magical demo works.
   - A build agent should be able to begin Phase 0/1 immediately without re-planning the product.

Do **not** spend planning effort on branding, marketing pages, billing, teams/organizations, or a polished dashboard beyond what the MVP needs to prove the core system.

---

# 1. Source of the Product Idea

YC's Fall 2026 Requests for Startups includes **"Self-Maintaining APIs"**:

https://www.ycombinator.com/rfs#self-maintaining-apis

The key problem YC describes is that API communication is broken:

- Breaking changes are announced but missed.
- Useful features launch but are not adopted.
- Changelogs are passive.
- Agentic coding tools have made it normal for external tools to have repository access.
- The missing application layer connects **API providers directly to their customers' codebases**.
- Their example is effectively: a provider changes its API, an agent finds the affected usages in customer repositories, and creates the migration.

That is the starting point, but **we want to push the idea further than "detect change -> scan repo -> open PR."**

Several current products already move in that direction. We need a stronger systems primitive.

---

# 2. Product Thesis

## The company is provider-first

The primary buyer/customer is the **API provider**, not the API consumer.

The provider's desired outcome is:

> **Ship your API. Invariant ships the change everywhere else.**

A more technically exact version:

> **Deploy the new API immediately. Invariant keeps existing integrations compatible and migrates connected customer code forward.**

The provider should not have to coordinate every API evolution with thousands of customers.

Consumers benefit, but they should not need to become independent Invariant customers merely to avoid breakage.

---

# 3. What We Are NOT Building

Do not collapse the project into any of these:

### Not an API change monitor

```
change
  -> alert
```

Too weak.

### Not a generic API diff product

Tools already deterministically detect OpenAPI/protobuf breaking changes.

### Not just a blast-radius scanner

```
change
  -> find affected call sites
```

Useful, but not the product.

### Not just an automatic PR bot

```
change
  -> edit repo
  -> PR
```

This is already becoming a category and is close to the literal YC suggestion.

### Not "Relay + Jev"

Relay-like functionality is only one downstream capability. Rebuild it natively.

### Not an AI proxy in the API hot path

No LLM or Jev should be deciding how to mutate live financial/API traffic per request.

### Not a magical claim that every breaking change is automatically solvable

Some changes require information the old consumer does not possess, alter side effects, change auth, remove capabilities, or require business decisions. Invariant needs a principled way to recognize these cases.

---

# 4. The Core Insight: Treat API Evolution Like Compilation + Distribution

Today's provider workflow is generally:

```
provider code change
      ↓
OpenAPI / docs / changelog
      ↓
SDK release
      ↓
migration guide
      ↓
consumer eventually notices
      ↓
consumer changes code
```

We want:

```
provider PR
      ↓
understand exact structural + semantic change
      ↓
create ONE canonical machine-readable change artifact
      ↓
compile it into multiple targets
      ↓
distribute those targets before/with the provider release
```

The central abstraction is currently called an:

# API Evolution Bundle (AEB)

An AEB is the versioned, signed artifact representing a provider API evolution.

Conceptually:

```
                 API EVOLUTION BUNDLE
                          │
       ┌──────────────────┼───────────────────┐
       │                  │                   │
       ▼                  ▼                   ▼
 Semantic change     Runtime compat      Source migration
       │                  │                   │
       ├─────────────── verification ─────────┤
       │                  │                   │
       ▼                  ▼                   ▼
      SDKs              rollout             docs
```

The provider change is understood **once**.

Everything else consumes the resulting artifact.

The plan should audit the name and exact shape, but preserve the deeper principle:

> **One provider-side source of truth for an API evolution, compiled into the mechanisms needed to keep consumers working and move them forward.**

---

# 5. Why Provider-Side Understanding Matters

Most migration products are downstream/reconstructive:

```
provider already changed
        ↓
read changelog/spec diff
        ↓
infer what provider meant
        ↓
infer customer impact
        ↓
patch customer
```

This throws away the highest-quality source of truth: **the provider and provider PR at the moment the change is authored**.

Invariant should operate inside the provider's development lifecycle.

Example:

```diff
- amount: number
+ amount_cents: integer
```

A structural diff can detect that fields changed.

It cannot prove that:

- both fields represent the same underlying monetary quantity,
- one uses major currency units,
- one uses minor currency units,
- conversion is multiply/divide by 100,
- conversion is reversible for the provider's supported currencies,
- the side effects and business semantics are otherwise unchanged.

Invariant should infer a semantic interpretation and, where necessary, ask the provider engineer to confirm it **while the PR context is fresh**.

Once confirmed, that becomes canonical migration knowledge.

Downstream systems should not have to rediscover it independently.

---

# 6. Semantic IR

The provider change should compile into a typed **Semantic Intermediate Representation** rather than free-form prose.

Illustrative only:

```yaml
change_id: chg_...
operation: payments.create

change:
  family: representation_change

concept:
  kind: monetary_amount

old:
  field: amount
  representation: major_currency_unit
  type: decimal

new:
  field: amount_cents
  representation: minor_currency_unit
  type: integer

mapping:
  forward:
    op: scale
    factor: 100
  reverse:
    op: scale
    factor: 0.01

properties:
  semantic_meaning_preserved: true
  reversible: true
  lossy: false
  requires_external_information: false
```

This is **not a final schema**. Fable must design/audit the actual IR.

Requirements:

- Versioned.
- Extensible without turning into untyped JSON soup.
- Separates structural facts from semantic assertions.
- Captures evidence/provenance.
- Captures whether assertions were deterministic, Jev-inferred, System-2-inferred, provider-confirmed, test-confirmed, or observed.
- Captures confidence where probabilistic judgments exist.
- Expresses transformability/reversibility.
- Supports request and response changes.
- Can represent endpoint/path/header/auth/error/event semantic changes where possible.
- Does not claim representability for arbitrary business logic.

The IR is intended to be the bridge between intelligence and deterministic infrastructure.

---

# 7. Jev's Intended Role

Research TypeSafe's current Jev capabilities before finalizing this.

Current high-level model:

```
deterministic structural diff
          ↓
Jev semantic questions
          ↓
high-confidence + low-risk?
    /                \
  yes                no
   ↓                  ↓
semantic IR       System 2 / provider
                       ↓
                  semantic IR
```

Jev should be evaluated for atomic typed judgments such as:

- Which old field/operation conceptually corresponds to a new one?
- What change family best describes this delta?
- Is this likely a rename, representation change, nesting change, unit change, semantic replacement, split, merge, auth change, behavior change, or unknown?
- Does old field X and new field Y represent the same business concept?
- Is the change plausibly reversible?
- Does the available evidence contain enough information to translate?
- Which known compatibility pattern best matches this change?
- Which risk/repair class should the change enter?
- Does the provider documentation support the inferred semantic mapping?

Use deterministic facts wherever possible and Jev only for the semantic ambiguity deterministic tooling cannot resolve.

### Important

Jev's output is **not permission to mutate production traffic**.

Probabilistic intelligence helps build the candidate artifact.

A separate verification and policy layer decides whether a compatibility artifact may ship.

---


## Jev Evaluation Harness — Required

As part of the planning output, design a concrete **Jev evaluation harness** that must be implemented early in the build.

The purpose is to empirically determine where Jev provides a real structural advantage over deterministic logic and a System 2 model.

Build a labeled corpus of representative API changes covering at least:

- field renames,
- nesting/unnesting,
- unit/representation changes,
- enum remapping,
- endpoint/path changes,
- type changes,
- splits/merges,
- semantic replacements,
- behavior-changing cases,
- missing-information cases,
- intentionally ambiguous changes,
- non-automatable changes.

For each case, define ground-truth labels for tasks such as:

- old/new semantic field alignment,
- change-family classification,
- semantic-equivalence judgment,
- reversibility,
- whether required information exists,
- repair-class routing,
- known-transform matching,
- escalation-to-System-2 decision.

Benchmark Jev against:

1. deterministic structural/rule-based baselines,
2. the selected System 2 reasoning model,
3. hybrid pipelines such as deterministic-first -> Jev -> System 2.

Measure at minimum:

- accuracy,
- false-positive rate,
- false-negative rate,
- confidence calibration,
- abstention quality,
- latency,
- cost,
- batching efficiency,
- performance by change class,
- performance on ambiguous/adversarial examples.

Do not judge Jev only by aggregate accuracy.

For safety-critical decisions, explicitly measure whether **high-confidence Jev outputs are actually more reliable than the overall population**. Calibration matters because Invariant may use confidence thresholds to decide whether to:

```text
accept semantic interpretation
        ↓
request deterministic verification
        ↓
escalate to System 2
        ↓
require provider confirmation
```

The plan should define an initial labeled dataset format, evaluation runner, metrics, thresholds, and CI/regression strategy.

As the product evolves, every newly observed API-change pattern or semantic failure should be convertible into a regression fixture.

### Required architectural rule

Jev should only own a production decision if the evaluation harness demonstrates that it is better suited than a simpler deterministic mechanism at the required reliability/cost/latency tradeoff.

If Jev does not outperform a simpler mechanism for a task, use the simpler mechanism.

If Jev is useful but not reliable enough for autonomous action, use it as a router, candidate generator, or escalation signal instead.

The goal is to make Jev an **empirically justified systems component**, not an architectural assumption.


# 8. The Repair-Class Model

Invariant must explicitly acknowledge that different changes require different repair channels.

The exact taxonomy should be audited, but a useful starting point is:

### Class A — Transparently adaptable

Examples:
- rename
- nesting/unnesting
- safe type widening
- unit representation with known exact mapping
- endpoint/path move with identical semantics
- known enum mapping

Possible outcome:
- runtime adapter
- deterministic codemod
- automatic after verification

### Class B — Source-migratable but poor runtime fit

Examples:
- SDK method restructuring
- async surface changes that can be rewritten in source
- library import changes
- type/interface changes where source migration is deterministic

Possible outcome:
- source migration PR
- temporary runtime compatibility if safe

### Class C — Requires missing information

Example:

Old:
```text
create_payment(amount)
```

New:
```text
create_payment(amount, regulatory_identity_document)
```

The old integration does not contain the required information.

Outcome:
- cannot silently adapt
- generate targeted developer action / partial migration

### Class D — Behavioral/business decision

Examples:
- a synchronous operation becomes genuinely asynchronous
- changed side effects
- new fraud/routing/business policy
- a feature exists but adopting it changes product behavior

Outcome:
- contextual recommendation or guided migration
- never silently invent business intent

### Class E — Not safely automatable

Examples:
- removed capability with no equivalent
- noninvertible semantics that violate old guarantees
- incompatible auth/security constraints
- uncertain mapping above risk threshold

Outcome:
- explicit breaking migration / human decision

Fable should improve this taxonomy and define machine-enforceable gates.

---

# 9. Runtime Contract Virtualization

This is the part that pushes beyond "PR bot."

The provider should ideally operate one **canonical current API contract** internally.

Invariant lets old consumers continue behaving as if their historical contract still exists.

Conceptually:

```
                         CANONICAL CURRENT API
                                  │
                         Invariant Data Plane
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
        virtual C91          virtual C122        virtual C147
              │                   │                   │
         old consumer         old consumer        new consumer
```

A consumer does **not** need to download a new adapter on every provider release.

The compatibility transformation runs at the provider side / provider edge.

Request path:

```
consumer request
      ↓
identify expected contract
      ↓
old-contract -> canonical request transform
      ↓
provider's canonical backend
      ↓
canonical -> old-contract response transform
      ↓
consumer receives expected behavior
```

This runtime compatibility is a **safety net** that allows the provider to deploy without waiting for every consumer migration.

It should not become infinite permanent technical debt. The source migration system exists to move integrations forward and retire old virtual contracts.

---

# 10. Contract Identity

Runtime compatibility only works if Invariant can determine what contract a consumer expects.

This is a first-class systems problem, not an implementation detail.

Possible identity signals:

- explicit provider API-version header,
- URL version (`/v1`, `/v2`),
- API key/account default version,
- SDK version mapped to an API contract,
- a future explicit contract fingerprint emitted by provider SDKs,
- webhook endpoint version,
- provider-defined client metadata.

For example, Stripe already has API-version mechanisms such as `Stripe-Version`, account defaults, webhook endpoint versions, and SDK versions aligned to API versions.

Longer-term, Invariant may introduce a **Contract Fingerprint**:

```text
provider: stripe
contract: sha256:...
sdk: stripe-node@...
```

Potential request metadata:

```http
Invariant-Contract: sha256:...
```

Do not assume this is always available.

Fable must design:

- how existing providers are onboarded,
- how historical clients are mapped,
- how uncertainty is handled,
- how contract identity differs from actual usage,
- whether contract identity belongs at account, credential, endpoint, SDK, request, or some combination,
- how raw HTTP clients work,
- how spoofing/tampering is prevented.

---

# 11. Contract Registry vs Consumer Usage Profile

Do not conflate:

1. **What contract a consumer expects**, and
2. **What subset of that contract the consumer actually uses.**

A customer on contract C91 may use only 4 operations.

A useful provider-side primitive may be a privacy-minimized **Consumer Usage Manifest/Profile** derived from traffic metadata:

```yaml
consumer: acct_...
contract: C91
uses:
  - payments.create
  - payments.retrieve
  - refunds.create
fields_observed:
  ...
```

This can allow a provider to know that a global breaking change affects only 2% of customers **without reading customer repositories**.

Fable should evaluate this carefully:

- Does this create enough value to justify telemetry complexity?
- Can it be based on operation IDs/paths/statuses without retaining bodies?
- How is PII avoided?
- What does it improve in release gating?
- Could it reduce unnecessary migration PRs?
- How is sampling handled?
- Can source analysis and runtime usage be reconciled when both are available?

This may be an important overlooked primitive.

---

# 12. Compatibility Programs / Compatibility IR

Do not execute arbitrary model-generated code in the provider's traffic path.

The output of semantic analysis should compile into a constrained, deterministic compatibility representation.

Illustrative operations:

- rename
- move
- nest
- unnest
- cast
- scale
- default
- map-enum
- map-error
- rewrite-path
- rewrite-header
- split
- merge
- derive from existing deterministic fields
- drop
- conditional mapping over closed predicates

The exact language must be designed.

Requirements:

- deterministic
- serializable
- versioned
- validated before execution
- sandboxable
- bounded resource usage
- auditable
- ideally amenable to static analysis
- composable where semantics permit
- impossible to execute arbitrary network/file/system code
- safe for high-throughput request/response execution

Important question for Fable:

> Should we actually compile to WASM/native bytecode in the MVP, or would a carefully designed interpreter over a small IR be faster to build, easier to audit, and already fast enough?

Do not choose WASM because it sounds sophisticated. Envoy's Wasm support has stability caveats. Benchmark and justify the MVP decision.

---

# 13. Compatibility Graph

Contracts evolve:

```
C100 -> C101 -> C102 -> C103 -> C104
```

Naively chaining four adapters on every request is poor architecture.

Invariant should investigate a contract graph where transformations can be composed/flattened:

```
T100→101
  ∘
T101→102
  ∘
T102→103
  ∘
T103→104
       ↓
compile/verify
       ↓
T100→104
```

But composition is **not always algebraically safe**.

Fable must design rules for:

- which transformations compose,
- which transformations are lossy,
- reversibility,
- rounding/precision,
- default values,
- error mappings,
- ordering,
- behavior/side effects,
- stateful API changes,
- how direct-to-current transforms are regenerated,
- how test evidence is preserved after composition.

Prefer a direct compiled path from each **active historical contract -> current canonical contract** rather than long chains in the hot path.

---

# 14. Provider Control Plane

The provider-side integration should begin before merge.

Conceptual pipeline:

```
provider PR
    ↓
extract/generate old + proposed API contracts
    ↓
deterministic structural diff
    ↓
semantic analysis (Jev + provider evidence)
    ↓
Semantic IR
    ↓
repair-class decision
    ↓
candidate API Evolution Bundle
    ↓
compatibility/migration compilation
    ↓
verification
    ↓
release status
```

The provider should get something like:

```text
API Release Impact — C204 -> C205

47 contract changes

41 additive / trivially compatible
 3 runtime-adaptable
 1 deterministic source migration
 1 requires customer information
 1 behavior-changing / review required

Active customer contracts: 19
Affected customer accounts: 713
Unaffected active customers: 12,802

Runtime compatibility compiled: 18 / 19 contracts
Unresolved contract: C117

Release status: BLOCKED
Reason: one active contract cannot be preserved safely.
```

The plan should decide what actually blocks releases and what is warning-only. Providers need policy control, but the MVP should not become a full policy product.

---

# 15. Data Plane

There should be a strict separation:

## Control plane

May use:
- deterministic diffing,
- Jev,
- System 2 models,
- provider confirmation,
- tests,
- compilers,
- asynchronous processing.

## Data plane

Must be:
- deterministic,
- low latency,
- highly available,
- observable,
- versioned,
- rollbackable,
- safe when the Invariant control plane is unavailable.

### Deployment models to evaluate

1. **Hosted reverse proxy / compatibility edge**
   - easiest central MVP
   - fastest to demo
   - introduces latency/trust/data-residency/availability concerns

2. **Provider-hosted sidecar / gateway processor**
   - better trust boundary
   - harder onboarding
   - could integrate through Envoy `ext_proc` or a similar gateway extension

3. **Provider framework middleware/library**
   - easy in a narrow stack
   - language/framework-specific
   - can be a good MVP if carefully selected

4. **Gateway-specific plugin**
   - Kong/Envoy/etc.
   - fragmented ecosystem

Fable must research, compare, and choose the MVP deployment approach while preserving a credible path to provider-hosted execution.

Do not leave the choice unresolved.

---

# 16. Critical Runtime Issues We Must Not Handwave

The plan must explicitly address these.

## 16.1 Authentication and request signing

Mutating a request after a consumer signs it may invalidate the signature.

Examples include:
- request-body signatures,
- canonical request signatures,
- webhook signatures,
- HMAC payload verification.

Ask:
- Must transformation run after provider auth verification?
- Does it need a trusted internal insertion point?
- Can a public reverse proxy support every auth model?
- Which auth/signing modes should be excluded from MVP?

## 16.2 Idempotency

Adapters must not accidentally:
- alter idempotency-key behavior,
- replay a side-effectful request,
- duplicate effects,
- turn a retry into a new operation.

## 16.3 Side effects and shadow testing

"Replay historical traffic against the new API" is dangerous for POST/PUT/PATCH/DELETE.

Never assume production traffic can simply be replayed.

The plan must distinguish:
- pure/read operations,
- staging/sandbox execution,
- provider-supplied test environments,
- recorded request/response differential tests,
- state snapshots,
- side-effect isolation,
- synthetic fixtures.

## 16.4 Precision and money

`49.99 * 100` is not automatically safe in every runtime/currency.

Adapters must understand:
- decimal representation,
- currency minor units,
- rounding,
- overflow,
- exactness.

## 16.5 Pagination/cursors

Opaque cursors may encode server state/version semantics and cannot necessarily be transformed.

## 16.6 Streaming/binary/multipart

Likely exclude from MVP.

## 16.7 WebSockets/SSE/gRPC

Likely out of MVP unless Fable finds a compelling simpler scope.

## 16.8 Error semantics

Compatibility includes:
- status codes,
- error types,
- error bodies,
- retry semantics,
- rate-limit behavior.

## 16.9 Stateful semantics

Some changes depend on:
- database state,
- previous requests,
- external entities,
- side-effect ordering.

A JSON shape translator cannot preserve arbitrary state-machine semantics.

## 16.10 Latency and payload buffering

Request/response body transformation may require buffering.

The plan must state:
- maximum MVP payload size,
- streaming behavior,
- latency budget,
- timeouts,
- fail-open/fail-closed behavior.

## 16.11 Data privacy

Prefer not to persist API bodies unless strictly required.

Define:
- redaction,
- encryption,
- retention,
- tenant isolation,
- telemetry minimization,
- provider-hosted path.

## 16.12 Rollback

If a bad adapter ships:
- how is it disabled globally?
- per contract?
- per customer?
- how quickly?
- is the last-known-good adapter cached locally?

---

# 17. Verification: The Product Lives or Dies on Trust

A wrong compatibility adapter may silently corrupt production behavior.

Therefore:

> **"Model confidence is high" is never sufficient verification.**

The plan needs a layered verifier.

Possible layers:

1. Structural validation.
2. Static properties of the Compatibility IR.
3. Golden contract fixtures.
4. Provider test suite.
5. Generated property tests.
6. Recorded request/response compatibility corpus.
7. Sandbox/staging differential testing.
8. Shadow execution where side effects are impossible or safely isolated.
9. Canary contract rollout.
10. Runtime metrics/divergence detection.
11. Immediate rollback.

A useful conceptual property:

```text
old_observable_behavior(x)
≈
backward_adapter(
    new_observable_behavior(
        forward_adapter(x)
    )
)
```

But define what `≈` means per operation.

Do not pretend byte equality is always the right notion of semantic compatibility.

Fable should design a test/evidence model that records **why** a compatibility claim is trusted.

---

# 18. Consumer Source Migration — Rebuild This Natively

This subsystem is required because runtime compatibility prevents immediate breakage but does not move codebases forward.

Do **not** wrap Relay.

Build a new **Consumer Migration Engine** around the API Evolution Bundle.

The advantage is that this engine already knows:

- exactly what the provider changed,
- the provider-confirmed semantic meaning,
- the canonical old/new contract identifiers,
- known deterministic transforms,
- runtime compatibility rules,
- affected operations/schema paths,
- rollout/deprecation context.

It should not start from a changelog and rediscover the migration.

Conceptual flow:

```
API Evolution Bundle
        ↓
consumer repository
        ↓
dependency / SDK / raw-HTTP identification
        ↓
typed/static usage index
        ↓
affected call sites
        ↓
deterministic codemod where possible
        ↓
System 2 only for genuinely semantic/source-level cases
        ↓
compile/typecheck/tests
        ↓
migration PR
```

### MVP scope recommendation to audit

Strongly consider:
- **TypeScript only**
- one SDK/provider fixture
- AST/type-aware indexing
- deterministic codemods for supported change families
- no magical polyglot source rewriter in v0

The engine should produce provenance:

```text
This edit exists because:
Provider change: chg_2039
Contract: C103 -> C104
Affected API operation: payments.create
Semantic mapping: amount -> amount_cents
Provider confirmation: yes
Transform verification: passed
Source verification: tsc + tests passed
```

---

# 19. Consumer Distribution / Permissions

Runtime compatibility can be invisible to the consumer.

Source-code migration cannot happen without repository permission.

Avoid a two-sided sales model.

The provider should be able to sponsor the consumer updater.

Potential UX:

```text
Keep your Acme API integration automatically updated

Acme sponsors automatic integration maintenance.
Connect your GitHub repository.

[Connect GitHub]
```

The consumer grants repository access to **Invariant / a provider-branded Invariant updater**, not to the provider itself.

Trust boundary:

```
provider semantic data ───► Invariant ◄─── customer repo permission
                                │
                                ▼
                           migration PR
```

The provider does not receive consumer source.

Fable should investigate the best permission architecture and whether a GitHub App is the correct first integration.

---

# 20. Breaking Changes vs New Features

These must be treated differently.

## Breaking changes

Goal:
- preserve old behavior immediately,
- migrate source automatically where safe.

## New features

Do **not** automatically invent product intent.

Example:

Provider launches a fraud capability.

Invariant/consumer migration engine may identify:

```text
This repository has custom fraud logic in src/payments/fraud.ts.
The provider has introduced a capability that may replace it.
```

But it should generally propose/recommend rather than silently rewrite business behavior.

The AEB may therefore carry:
- new capability description,
- applicability predicates,
- migration templates,
- affected existing patterns,
- adoption guidance.

The plan should explicitly separate:
- compatibility maintenance,
- safe source migration,
- feature adoption.

---

# 21. Possible Standards / Existing Primitives

Do not invent replacements for mature primitives without reason.

Research at least:

### OpenAPI + OpenAPI Overlay

OpenAPI Overlay 1.1 provides repeatable transformations over OpenAPI documents.

It does **not** solve consumer code migration or semantic compatibility, but may be useful as one representation target/input.

### oasdiff

Mature OpenAPI structural/breaking-change detection.

Potentially use rather than rebuilding baseline diff logic.

### Buf

Useful reference architecture for how schema compatibility can be categorized and checked in CI for Protobuf.

### Envoy External Processing

Envoy can delegate request/response header/body processing to an external gRPC processor.

This may be a useful provider-hosted data-plane integration model.

### Envoy Wasm

Portable local execution is conceptually attractive, but current Envoy documentation still marks Wasm filtering as experimental. Do not default to it without justification.

### Kong/request transforms and API gateways generally

Useful precedent: request/response transformation is an established data-plane primitive.

Invariant's novel work should be:
- understanding the provider change,
- compiling compatibility,
- verification,
- contract management,
- distribution,
not reinventing packet proxying unless necessary.

---

# 22. API Evolution Bundle — Required Properties

Fable should design the real schema.

The bundle likely needs:

```text
identity
- provider
- bundle id
- from contract
- to contract
- created from provider commit/PR
- schema version

structural delta
- endpoints
- methods
- parameters
- schemas
- headers
- auth
- responses
- errors/events

semantic delta
- concept mappings
- behavior assertions
- transformability
- reversibility
- information requirements
- risk class

provenance
- structural tool evidence
- source locations
- documentation
- Jev judgments
- model judgments
- provider confirmations

compiled artifacts
- runtime compatibility program(s)
- source migration recipe(s)
- SDK metadata
- docs/changelog data

verification
- tests run
- fixtures
- results
- invariants checked
- confidence/evidence gates

rollout
- eligible contracts
- blocked contracts
- canary strategy
- expiry/deprecation policy

security
- signature
- content digest
- issuer
```

Consider content-addressing/signing so a provider can know the exact artifact deployed at the data plane and used for consumer migrations.

---

# 23. Release Lifecycle

Desired high-level lifecycle:

```
1. Provider opens API-changing PR.
2. Invariant generates old/new structural contract.
3. Deterministic diff identifies deltas.
4. Jev/semantic analysis interprets ambiguous meaning.
5. Provider confirms only what cannot be proven.
6. Semantic IR is frozen for the release candidate.
7. AEB is generated.
8. Runtime compatibility is compiled for active historical contracts.
9. Consumer impact is computed.
10. Verification runs.
11. Release gate returns PASS / WARN / BLOCK.
12. Provider deploys canonical API + compatible data-plane artifact.
13. Old integrations continue operating.
14. Connected consumer repositories receive migration PRs.
15. Consumers migrate when convenient.
16. Old contract usage reaches zero.
17. Compatibility artifact is retired.
```

Fable should identify where this lifecycle is overcomplicated and compress it if possible.

---

# 24. The Potentially Powerful Flywheel

The company may accumulate a valuable compatibility corpus, but do not depend on this for the MVP.

Over time Invariant can learn:

- common semantic change patterns,
- provider-specific conventions,
- safe transform templates,
- failure patterns,
- confidence calibration,
- language-specific migration templates,
- compatibility evidence,
- which change classes are routinely reversible.

Important privacy constraint:

The moat should ideally be **semantic change + verified compatibility knowledge**, not raw customer payloads or proprietary source code.

The plan should keep provider/customer data boundaries explicit.

---

# 25. MVP: Prove the Magic, Not the Entire Platform

The MVP must demonstrate the whole differentiated loop.

## Recommended narrow scope

Audit this, but start narrow:

- JSON REST APIs
- OpenAPI 3.x
- one provider repository
- one current canonical API
- a small number of historical contracts
- TypeScript consumer repositories
- one consumer SDK style + possibly raw HTTP only if inexpensive
- a constrained set of compatibility transform families
- no streaming/binary/multipart
- no gRPC
- no arbitrary auth schemes
- no "every API provider" abstraction yet

## Magical end-to-end demo

Create:

- one sample provider,
- three unmodified consumer applications built against different historical API contracts.

Then:

1. Provider changes an API in a way that is structurally breaking but semantically preservable.
2. Invariant detects the structural change in the provider PR.
3. Jev/semantic analysis identifies the intended semantic mapping.
4. Provider confirms if required.
5. Invariant generates the AEB.
6. Invariant compiles verified compatibility programs.
7. Provider deploys the new canonical API.
8. All three **unmodified old applications continue to work**.
9. The consumer migration engine finds affected call sites in connected TypeScript repos.
10. It generates minimal source migrations.
11. TypeScript typecheck/tests pass.
12. Migration PRs are produced.
13. After a consumer migrates, its old runtime compatibility requirement is no longer needed.

The demo should make this statement true:

> **"I made a breaking API change here, deployed it, and every old integration kept working while the connected codebases received the correct migration."**

That is the product moment.

---

# 26. Recommended MVP Change Families

Fable should choose a small, rigorous subset.

Potential candidates:

1. Field rename.
2. Field move/nesting change.
3. Exact representation/unit transform where provider confirms semantics.
4. Endpoint/path rename.
5. Enum rename with bijective mapping.
6. Request required-field introduction only when an exact deterministic default exists and is semantically valid.
7. Response type change only if provably reversible.

Explicitly avoid in early MVP:
- auth model changes,
- side-effect changes,
- sync/async semantic transitions,
- streaming,
- complex polymorphic schemas,
- opaque cursor rewrites,
- transforms requiring external lookups,
- transforms needing arbitrary code.

A smaller trustworthy compiler is more valuable than a broad unsafe one.

---

# 27. Questions Fable Must Resolve

The final plan must answer these rather than leaving them open.

## Product/system boundary

1. What is the smallest primitive that makes this product meaningfully different from PR-only migration tools?
2. Is the API Evolution Bundle the right central artifact, or is there a more elegant abstraction?
3. Is runtime contract virtualization essential to the MVP or should it be staged immediately after a smaller proof?
4. How do we avoid becoming an API gateway company?

## Provider integration

5. How do we derive the proposed contract from a provider PR?
6. What if the OpenAPI spec is stale or generated after code?
7. Should provider onboarding require OpenAPI for MVP?
8. Where does provider confirmation enter without making every change manual?

## Jev

9. Which exact judgments benefit from Jev?
10. Which should remain deterministic?
11. What confidence gates are appropriate?
12. How do we benchmark/calibrate Jev on our own API-change corpus?
13. When do we escalate to System 2?
14. What happens when Jev and structural evidence disagree?

## Runtime

15. Where should the data plane run in the MVP?
16. How does it identify consumer contract versions?
17. What happens if identity is ambiguous?
18. What is the latency budget?
19. What is the failure mode when Invariant runtime/control plane is down?
20. How are adapters rolled back atomically?
21. How are signed requests handled?
22. How are side effects/idempotency preserved?

## Compatibility compiler

23. What is the minimal IR?
24. Interpreter vs compiled artifact?
25. Which transformations are composable?
26. How is lossy transformation represented?
27. How is semantic equivalence verified?
28. How is contract flattening performed safely?

## Consumer migration

29. How is the new migration engine structured from scratch?
30. How do we index TypeScript call sites reliably?
31. How do we identify SDK calls vs raw HTTP?
32. Which migrations can be deterministic codemods?
33. When does System 2 write source?
34. What verification is required before a PR is allowed?
35. How are new features treated differently from breaking migrations?

## Permissions/trust

36. How can a provider sponsor code updates without reading consumer source?
37. Is a GitHub App the cleanest initial mechanism?
38. What exact scopes/permissions are required?
39. How do we make provenance visible in every source edit?

## Operations

40. What is persisted?
41. What can be recomputed?
42. How are bundle/artifact versions stored?
43. How do we observe compatibility runtime correctness?
44. What metrics/SLOs are necessary?
45. What does disaster recovery look like?
46. What should be deliberately excluded from MVP?

---

# 28. Required Plan Deliverables

The output from this planning pass should include all of the following.

## A. Executive technical decision

- Restate the final system in precise terms.
- Explain what was kept, changed, removed, or simplified from this brief.
- Identify the core differentiating primitive.

## B. Architecture diagram

At minimum show:

- provider repository/CI,
- contract extraction,
- structural diff,
- semantic analysis/Jev,
- provider confirmation,
- Semantic IR / AEB,
- verifier,
- artifact registry/control plane,
- runtime compatibility data plane,
- consumer migration engine,
- GitHub integration,
- observability/rollback path.

## C. Critical request sequence

Sequence diagram for:
- an old consumer calling the newly deployed provider API,
- request transform,
- provider processing,
- response transform.

## D. Provider release sequence

Sequence diagram from:
- provider PR,
- semantic compilation,
- verification,
- deployment,
- consumer migration distribution.

## E. Domain/data model

Concrete schemas/entities for at least:
- Provider
- API
- ContractSnapshot
- ContractIdentity
- ApiChange
- SemanticAssertion
- EvolutionBundle
- CompatibilityProgram
- VerificationEvidence
- Consumer/Integration
- ConsumerUsageProfile if retained
- MigrationRecipe
- MigrationRun
- RuntimeDeployment

Names can change.

## F. Interface contracts

Define major internal APIs/events:
- diff -> semantics
- semantics -> AEB compiler
- AEB -> runtime compiler
- AEB -> source migration engine
- runtime -> artifact registry
- provider CI -> control plane
- GitHub App -> migration service

## G. Compatibility IR design

- syntax/schema,
- validation,
- allowed operations,
- runtime execution model,
- type system if any,
- safety restrictions,
- composition rules,
- versioning.

## H. Jev design

- exact question primitives,
- state passed,
- batching strategy,
- confidence/risk policy,
- escalation rules,
- evaluation/calibration plan,
- examples.

## I. Verification model

- what is tested,
- what evidence is required,
- risk tiers,
- side-effect-safe validation,
- rollback,
- canary strategy.

## J. Consumer migration design

Rebuilt from scratch:
- code indexing,
- usage matching,
- AST/type system strategy,
- deterministic codemods,
- optional System 2 repair,
- compile/test gates,
- PR generation,
- provenance.

## K. Security/threat model

At least:
- tenant isolation,
- provider artifact signing,
- tampered contract IDs,
- malicious payloads,
- transformation bombs/resource exhaustion,
- secrets/auth,
- source-code access,
- model prompt injection through docs/specs/code,
- data retention,
- supply-chain risk,
- runtime compromise.

## L. Failure-mode table

For each key failure:
- detection,
- user impact,
- safe behavior,
- rollback/recovery.

## M. MVP repository structure

Choose concrete layout.

Example only:

```text
/apps
  /control-plane
  /provider-fixture
  /consumer-fixtures

/packages
  /contract
  /semantic-ir
  /aeb
  /diff
  /jev
  /compat-ir
  /compat-runtime
  /verifier
  /migration-ts
  /github
```

Do not copy this if a simpler structure is better.

## N. Tech-stack decisions

Choose:
- language(s),
- framework,
- DB,
- queue/event mechanism if needed,
- object/artifact storage,
- runtime execution approach,
- OpenAPI parser/diff tooling,
- TypeScript AST tooling,
- test framework,
- local dev environment,
- deployment target.

Explain each decision briefly.

## O. Build phases

Each phase must contain:
- goal,
- components,
- exact implementation tasks,
- interfaces introduced,
- tests,
- acceptance criteria,
- dependencies,
- risks.

The phases should lead from a local fixture to the full MVP demo.

## P. Test strategy

Include:
- unit,
- property,
- golden fixtures,
- differential compatibility,
- mutation/fuzz testing,
- integration,
- end-to-end,
- performance/latency,
- rollback,
- migration correctness.

## Q. MVP success criteria

Use measurable gates.

For example:
- supported compatibility transforms preserve defined observable behavior across all golden fixtures,
- no model inference in request hot path,
- deterministic rollback,
- old fixture consumers require zero source changes to survive provider release,
- migration patches typecheck and pass tests,
- ambiguous/unrepresentable changes are never silently adapted,
- explicit latency overhead target.

Fable should choose realistic numeric targets after evaluating the runtime approach.

## R. Deferred roadmap

List what belongs **after** the MVP:
- Python/Go/etc.
- gRPC/Protobuf
- GraphQL
- webhooks/event streams
- gateway plugins
- fully provider-hosted runtime
- feature-adoption recommendations
- cross-provider compatibility corpus
- enterprise controls
- additional SCMs beyond GitHub

Do not let roadmap work leak into MVP architecture unless necessary.

---

# 29. Planning Quality Bar

The resulting plan should feel like it was written by a principal/staff infrastructure engineer preparing a team to implement a production-bound system.

Avoid:

- buzzword architecture,
- "AI agent does X" without an interface or failure policy,
- vague arrows between boxes,
- unsupported automatic safety claims,
- huge abstraction layers with no MVP need,
- premature microservices,
- ambiguous technology choices,
- fake precision,
- assuming OpenAPI always reflects runtime behavior,
- treating Jev/LLMs as deterministic truth,
- assuming every breaking change is reversible,
- assuming consumer repositories are always available,
- assuming traffic can be replayed safely,
- assuming a provider can modify signed traffic anywhere in the network path.

Prefer:

- typed boundaries,
- explicit trust domains,
- small deterministic cores,
- evidence/provenance,
- low-coupling components,
- replayable build artifacts,
- versioned schemas,
- content-addressed artifacts where useful,
- observable state transitions,
- conservative automation,
- clear escape hatches,
- local reproducibility,
- test-first acceptance criteria.

---

# 30. The Deep Product Question to Keep Testing

Throughout the planning process, repeatedly ask:

> **Is there an even more elegant mechanism by which a provider can ship one API change and cause every integration to remain correct and/or update itself, without requiring thousands of independent agents to rediscover the same change?**

The current answer is:

```
provider intent
     ↓
semantic compilation once
     ↓
one canonical evolution artifact
     ↓
runtime compatibility + source migration + SDK/docs distribution
```

But this is a hypothesis.

If you find a cleaner abstraction, use it.

We care more about solving the problem elegantly than preserving the words "AEB", "Semantic IR", "contract virtualization", or any specific architecture proposed here.

---

# 31. Research / Supporting Sources

Use these as starting points, then perform fresh research where necessary.

## YC — primary problem statement

**Self-Maintaining APIs — Y Combinator Requests for Startups**

https://www.ycombinator.com/rfs#self-maintaining-apis

The core thesis: API providers should apply their changes into customer codebases rather than merely announcing them.

---

## TypeSafe AI / Jev

**TypeSafe AI Introduction**

https://docs.typesafe.ai/

Important concepts:
- Jev as a System One model.
- State + typed questions -> structured decisions.
- Choice / Score / Noul.
- Parallel atomic questions.

**Confidence**

https://docs.typesafe.ai/confidence

Important for:
- risk-dependent thresholds,
- uncertainty as a routing signal,
- high/medium/low-confidence behavior.

**Function calling cookbook**

https://docs.typesafe.ai/cookbooks/function_calling

Useful for understanding:
- closed typed outputs,
- mapping unstructured state into constrained software decisions.

**Introducing System One Models & Jev**

https://typesafe.ai/blog/introducing-system-one-models-and-jev

Treat vendor performance/cost claims as claims to benchmark on our own workload.

---

## API specifications / evolution

**OpenAPI Overlay Specification 1.1**

https://spec.openapis.org/overlay/v1.1.0.html

Potentially useful for:
- repeatable transformations over OpenAPI descriptions,
- adding machine-readable evolution metadata,
- integrating with existing API tooling.

It does not replace our semantic/migration layer.

**oasdiff**

https://github.com/oasdiff/oasdiff

**oasdiff breaking-change docs**

https://github.com/oasdiff/oasdiff/blob/main/docs/BREAKING-CHANGES.md

Potential use:
- structural OpenAPI diff,
- breaking-change classification,
- CI integration,
- machine-readable outputs.

Do not rebuild this class of deterministic diffing without a strong reason.

**Buf breaking-change detection**

https://buf.build/docs/breaking/

Useful systems-design reference:
- compatibility categories,
- contract-level breaking checks,
- CI/registry enforcement,
- difference between source compatibility and wire compatibility.

---

## Real-world API versioning

**Stripe API versioning**

https://docs.stripe.com/api/versioning

Useful because Stripe demonstrates:
- version headers,
- account defaults,
- SDK/API-version coupling,
- webhooks with explicit/default versions,
- real operational handling of backward-incompatible releases.

**Stripe SDK version/support policy**

https://docs.stripe.com/sdks/versioning

Use as a concrete example of the migration/versioning burden providers carry today.

---

## SDK generation / provider tooling

**Speakeasy — handling breaking SDK changes**

https://www.speakeasy.com/docs/sdks/manage/breaking-changes

**Speakeasy — SDK preview/breaking-change detection**

https://www.speakeasy.com/docs/sdks/guides/sdk-preview-breaking-changes

**Speakeasy — publishing SDKs**

https://www.speakeasy.com/docs/sdks/publish-sdk

Use these to understand:
- what provider-side SDK tooling already automates,
- what remains unsolved when old consumers do not upgrade,
- how spec changes propagate into generated SDK releases.

---

## Runtime / gateway primitives

**Envoy External Processing**

https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_proc_filter

Potentially useful for:
- provider-hosted request/response mutation,
- separating gateway/data plane from an external compatibility processor.

**Envoy Wasm**

https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/wasm_filter.html

Potential long-term execution path, but current docs mark this area experimental. Audit before selecting.

**Kong Request Transformer**

https://developer.konghq.com/plugins/request-transformer/reference/

Useful precedent showing that API gateways already perform request transformations. Our differentiated layer is the automatic semantic compilation, verification, contract management, and distribution.

---

## Competitive references — study, do not copy

**Patchline**

https://patchline.cloud/

Current model:
- ingest changelogs/OpenAPI/SDK releases,
- classify,
- blast-radius scan,
- create migration PRs.

This validates demand but also demonstrates why "scan + PR" alone is not enough differentiation.

**Repairo**

https://www.heyrepairo.in/

https://github.com/adityacs50-lab/Repairo

Current model includes:
- OpenAPI diff,
- AST/token impact mapping,
- deterministic source repair,
- compile/syntax validation,
- optional model help in ambiguous cases.

Again: evidence that a PR-only migration layer is already emerging.

Fable should search for additional current competitors, especially provider-first systems, API-version virtualization, automated backwards compatibility, and API-change distribution products.

---

# 32. Final Deliverable Instruction

After completing research and architectural analysis, produce a **single coherent build plan**.

The plan should:

1. Start with the final product/system thesis.
2. State the architectural changes you made relative to this brief.
3. Present the chosen architecture.
4. Present the data model and core IR/artifact formats.
5. Present the exact provider and consumer flows.
6. Present the Jev design.
7. Present the runtime strategy.
8. Present the rebuilt consumer migration engine.
9. Present security, verification, observability, rollback, and failure behavior.
10. Present the repository structure and concrete stack.
11. Present implementation phases with acceptance criteria.
12. End with the exact first build task.

Do not implement the product during this planning pass unless explicitly instructed.

The output must be specific enough that the next session can begin building immediately without reopening fundamental architecture questions.

---

# North Star

> **API providers should be able to evolve their APIs without coordinating migrations across every customer.**

The ideal system makes API evolution feel like ordinary deployment:

```
provider changes API
        ↓
Invariant understands the change once
        ↓
Invariant compiles and verifies its consequences
        ↓
provider deploys
        ↓
existing integrations keep working immediately
        ↓
connected customer codebases migrate forward automatically
        ↓
legacy compatibility disappears as adoption completes
```

The product is not fundamentally an agent.

It is not fundamentally an API gateway.

It is not fundamentally a codemod system.

It is not fundamentally a schema diff tool.

The working hypothesis is:

> **Invariant is the compilation and distribution layer for API evolution.**

Audit that hypothesis aggressively—and if it survives, design the cleanest possible system that makes it real.
