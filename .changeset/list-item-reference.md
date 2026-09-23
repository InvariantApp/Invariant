---
"@invariant-app/proposer": patch
---

A named list of a choice that did not change no longer drafts its items' fields as newly required. The item of such a list is listed as a field of its own, and its list's reference was read as if it were the items', so Datadog's unchanged `LLMObsContentBlocks` drafted `display_block.*.type` in every release after it appeared, and each draft left a break the pair never had.
