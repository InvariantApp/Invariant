---
"@invariant-app/migrate-py": patch
---

A migration no longer stops forever on a value that leads back to itself. Value flow handed a value met again while it was still being followed its own unfinished answer, and where the cycle passed through a question to the checker the run waited on itself with nothing left to happen: an openai-python upgrade with Changes never finished. Such a value now ends there, as one met before any question already did.

A field no file of the consumer's spells is no longer looked up in the checker at all, since it is read and written only by its name; on an SDK with hundreds of Changes those lookups were nearly all of a run.
