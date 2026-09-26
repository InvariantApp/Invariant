# @invariant-app/verifier

## 0.5.0

### Patch Changes

- 353f443: `invariant check` fits in memory on Stripe-sized specifications. The lens laws built the generator for a schema in full before drawing a value, one generator for every path through the schemas it reaches, and where nearly every object reaches nearly every other, as Stripe's do through expandable fields, that ran out of a 12 GB heap. A schema's generator is now built the first time a value is drawn from it, and one schema reached along many paths shares one generator per depth. The values drawn, and their shrinks, are the same as before.
  
  The lens laws also finish in reasonable time there. Declared losses are parsed once per schema and removed in one walk, the release's shared blocks are compiled once rather than for every schema, and a law that fails tries at most a thousand smaller values before reporting the smallest it found, saying so when a smaller one may exist. A law on one Stripe object had been shrinking a 1.6 MB value for an hour and a half.
  
  `schemaLenses` returns the lens of any schema of one release, compiling the release's shared blocks once; `schemaLens` is the same for one schema.
- Updated dependencies [0672745]
- Updated dependencies [353f443]
- Updated dependencies [eeeb512]
- Updated dependencies [2ab33a0]
- Updated dependencies [268385d]
  - @invariant-app/diff@0.5.0
  - @invariant-app/compiler@0.5.0
  - @invariant-app/runtime@0.5.0
  - @invariant-app/contract@0.5.0
  - @invariant-app/decimal@0.5.0
  - @invariant-app/ir@0.5.0

## 0.4.0

### Patch Changes

- ca7c00e: XML bodies are served. Amazon's CloudFront and CloudSearch declare every body as `text/xml`, and every Change to them was left unexplained because nothing read XML. The contract now reads an operation's XML body where it has no JSON one, so the proposer drafts for it and the prediction checks it as it does JSON; the compiler describes each XML body a site has work for, from the schema's OpenAPI `xml` object (element or attribute, wrapped or not, names, namespaces and what each place holds), as a site's `xml` program, a new program feature that asks for the next runtime; and the TypeScript runtime, the Node binding and the Go engine with its net/http middleware decode such a body into a tree, run the same instructions and write it back. Only the places the program names are decoded: every other element, and everything between elements, is written back exactly as it came, so a document nothing changed comes out byte for byte. The parser is written for hostile input: a document type declaration is refused, so no entity is expanded and nothing external is read, and nesting and namespace declarations are capped. What cannot be written back exactly is refused rather than guessed at: text among an object's elements, attributes on a value, an encoding other than UTF-8, and, at compile time, a map, a schema that contains itself, or a value read whose schema says nothing of it, which the release gate blocks. A program that reaches a parameter and an XML body at once is served too, as one with a form body is. A restatement of a whole body is no longer refused as a value with nowhere to be written back, since it writes nothing: CloudSearch restates each request body whole. The proposer also no longer asks a vocabulary decision where a case codec already serves the field, as Adyen's `Active` becoming `active`.
- Updated dependencies [6edee60]
- Updated dependencies [5da65b3]
- Updated dependencies [9458d83]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/compiler@0.4.0
  - @invariant-app/runtime@0.4.0
  - @invariant-app/contract@0.4.0
  - @invariant-app/diff@0.4.0
  - @invariant-app/decimal@0.4.0

## 0.3.0

### Patch Changes

- 782ec22: Generated values stay inside what their schema allows, and generation finishes. An integer bounded past what a double holds exactly, as every 64-bit column drf-spectacular and Java APIs describe is, made the generator draw forever: the gate on NetBox 3.6 outlasted a two and a half hour job without finishing its laws, and now takes seconds. An enum value the schema's own type rules out, such as the null drf-spectacular lists beside `type: string` on every choice field, is no longer drawn, so the laws stop blaming a release's Changes for a value its contract never allowed.
- 0036e1f: The lens laws check only the directions a schema travels. A field added to a schema only responses carry, drafted with no value because no request ever needs one, is no longer refused for what the request half would do to a request that cannot exist.
- e2168b7: The lens laws no longer refuse a `relax` for the values it declares it lets through. A relax runs nothing, so it was never counted as touching its schema: the values outside the old bounds it passes on were reported as a round trip failure of no Change at all, as Qdrant 1.18's lowered `max_query_limit` minimum was. A value outside the other contract's bounds at the relaxed place is now the loss that Change names, and anything else it breaks is still caught.
- 0036e1f: Checking a value against an OpenAPI 3.0 contract allows null where the schema says `nullable: true`. The lens laws generated such nulls and then refused them, which blocked any Change touching a schema with a nullable field.
- ac59d08: A decided fold on a vocabulary that is a schema of its own passes the lens laws: its values are checked inside a body, as every field holding one carries them, rather than as a whole body the runtime has nowhere to write back into. Where such a value really is a whole response or request body, the compiler now refuses the Change there instead of shipping a translation the runtime silently skips.
- Updated dependencies [e94a03b]
- Updated dependencies [0036e1f]
- Updated dependencies [9dc889d]
- Updated dependencies [e2168b7]
- Updated dependencies [d781b98]
- Updated dependencies [4d37d14]
- Updated dependencies [ac59d08]
  - @invariant-app/contract@0.3.0
  - @invariant-app/runtime@0.3.0
  - @invariant-app/compiler@0.3.0
  - @invariant-app/diff@0.3.0
  - @invariant-app/decimal@0.3.0
  - @invariant-app/ir@0.3.0

## 0.2.0

### Minor Changes

- ea463aa: `invariant observe` stands in front of an API, adapts nothing, and reports where its answers do not match its own specification, with no value from any response in the report. A contract can be given a deprecation and a sunset date in `invariant.yaml`, which the runtime tells that contract's callers on every answer. A JSON body is read whatever the provider called its media type, which the runtime already did.

### Patch Changes

- Updated dependencies [a136b88]
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [7c44320]
- Updated dependencies [0823e06]
- Updated dependencies [fad78f7]
- Updated dependencies [7c44320]
- Updated dependencies [e4f8878]
- Updated dependencies [2e2c416]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [80b2b43]
- Updated dependencies [a136b88]
- Updated dependencies [48948ea]
- Updated dependencies [9ee5787]
- Updated dependencies [80b2b43]
- Updated dependencies [80b2b43]
- Updated dependencies [e5723a1]
- Updated dependencies [d712bcf]
- Updated dependencies [fad78f7]
  - @invariant-app/runtime@0.2.0
  - @invariant-app/diff@0.2.0
  - @invariant-app/compiler@0.2.0
  - @invariant-app/ir@0.2.0
  - @invariant-app/contract@0.2.0
  - @invariant-app/decimal@0.2.0
