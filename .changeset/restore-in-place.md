---
"@invariant-app/compiler": patch
---

A value a Change puts back or fills in (`remove` with `restore`, `default`,
and the value `add` gives an old caller's request) is now written only where
the object the Change is scoped to is there. It used to create every object
on the way that was missing, so an answer that left out an optional object
reached an old caller with one holding only the restored field, where the
old server had sent no object at all.
