# @invariant-app/runtime-node

## 0.5.0

### Patch Changes

- Updated dependencies [eeeb512]
  - @invariant-app/runtime@0.5.0

## 0.4.0

### Patch Changes

- 407f319: A new op, `status {endpoint, from, to}`, for an operation that answers with another success status: Gitea 1.25 answers the creation of an Actions variable `201` where 1.24 answered `204`, and Immich 1.138 answers `204` where 1.137 answered `200` with nothing. An old caller is answered `from` wherever the operation now answers `to`, and what happens to the body is read from the two contracts: none where the old contract promised none, the body served as any body is where both carry one, and the Change refused where the old status promised a body the new one does not carry. It is exact. A success status removed is now adaptable, and the proposer drafts the op where the documents settle which status replaced which. Programs carry it as a site's `status` rules, which the TypeScript runtime, the Node binding and the Go engine's net/http middleware apply in turn to the provider's status, and which compose across a chain of releases; the response work of a release is filed under the status the provider answers with. A chain now finds each release's response work for a status as the runtime does, by the exact status, then its class, then `default`. A `move` may place a value beneath its own place, as Meilisearch's list of a rule's actions became the `pin` list of an object there, and a field of an object that declares no properties may be moved out of it. The TypeScript runtime now writes a copy of an object a `set` writes, as the Go engine always has, so a later write into one place no longer reaches every place it was written and the program itself. The proxy passes on an empty Host, HTTP/1.1's way of naming no host, where it refused it: Immich's suite sends one to see its share pages fall back to their public address. And a GET that came with a body is sent on without the length of the body it is not sent, where the provider waited for bytes that never came.
- ca7c00e: XML bodies are served. Amazon's CloudFront and CloudSearch declare every body as `text/xml`, and every Change to them was left unexplained because nothing read XML. The contract now reads an operation's XML body where it has no JSON one, so the proposer drafts for it and the prediction checks it as it does JSON; the compiler describes each XML body a site has work for, from the schema's OpenAPI `xml` object (element or attribute, wrapped or not, names, namespaces and what each place holds), as a site's `xml` program, a new program feature that asks for the next runtime; and the TypeScript runtime, the Node binding and the Go engine with its net/http middleware decode such a body into a tree, run the same instructions and write it back. Only the places the program names are decoded: every other element, and everything between elements, is written back exactly as it came, so a document nothing changed comes out byte for byte. The parser is written for hostile input: a document type declaration is refused, so no entity is expanded and nothing external is read, and nesting and namespace declarations are capped. What cannot be written back exactly is refused rather than guessed at: text among an object's elements, attributes on a value, an encoding other than UTF-8, and, at compile time, a map, a schema that contains itself, or a value read whose schema says nothing of it, which the release gate blocks. A program that reaches a parameter and an XML body at once is served too, as one with a form body is. A restatement of a whole body is no longer refused as a value with nowhere to be written back, since it writes nothing: CloudSearch restates each request body whole. The proposer also no longer asks a vocabulary decision where a case codec already serves the field, as Adyen's `Active` becoming `active`.
- Updated dependencies [5da65b3]
- Updated dependencies [407f319]
- Updated dependencies [ca7c00e]
  - @invariant-app/runtime@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [9dc889d]
  - @invariant-app/runtime@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [a136b88]
- Updated dependencies [a530d28]
- Updated dependencies [0823e06]
- Updated dependencies [ea463aa]
- Updated dependencies [80b2b43]
  - @invariant-app/runtime@0.2.0
