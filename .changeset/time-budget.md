---
"@invariant-app/runtime": patch
---

The per-body time budget is read after every instruction as well as every 256 steps. A program shorter than that never read the clock at all, so sixty moves over nine thousand items ran for more than a second against a five millisecond budget; they are now stopped with `TimeBudgetError` as the budget says.
