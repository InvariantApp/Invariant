---
"@invariant-app/contract": patch
---

Three ways a specification could make the reader see something it did not say are closed. A `$ref` to a file committed as a link to somewhere outside the repository is refused, where it used to be followed wherever the link pointed. A reference is resolved only through what the document itself holds, so `#/components/schemas/__proto__` or `.../constructor` no longer resolves to a JavaScript prototype and counts as defined. And a schema gathered from a file named `__proto__` is placed under a name of its own rather than lost. Separately, a schema that sits at more than 10,000 places is served by blocks that follow the value, as a recursive one is, instead of each place being listed: a few kilobytes of references that double at each level wrote a program that doubled with them, and sixteen levels ended the compiler with a stack overflow.
