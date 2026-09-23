---
"@invariant-app/verifier": patch
"@invariant-app/compiler": patch
---

A decided fold on a vocabulary that is a schema of its own passes the lens laws: its values are checked inside a body, as every field holding one carries them, rather than as a whole body the runtime has nowhere to write back into. Where such a value really is a whole response or request body, the compiler now refuses the Change there instead of shipping a translation the runtime silently skips.
