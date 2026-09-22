---
"@invariant-app/diff": minor
---

A response field that took a list of values where it allowed any value before is no longer reported as breaking: the differ's "enum value added" entries for it are dropped, found through properties, list items and union branches of the old document.
