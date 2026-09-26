---
"@invariant-app/migrate-py": patch
---

A `match` or a comparison on a value whose SDK vocabulary gained values across the upgrade is now shown. Anthropic's `stop_reason` gained `compaction`; code that matched on the old values still type-checked and quietly handled the new one as none of them. Each release's literal aliases are read, and where every string a decision names is one of an alias's old values, at least two of them, and the alias gained values the decision does not name, each case naming its values is shown with the values it misses, since which case should take them is the consumer's choice. A comparison is shown where it is written.
