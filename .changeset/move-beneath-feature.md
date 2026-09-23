---
"@invariant-app/ir": patch
"@invariant-app/compiler": patch
---

A program whose `move` places a value beneath its own place now asks for the runtime that can run it, so runtime 0.3.0 refuses it at load instead of failing at the first request. And `relax` with a list of types reads a value written as a choice of nothing but types, such as Mistral's `anyOf: [integer, null]`, as those types, where it had drafted a Change that could not compile.
