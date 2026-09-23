---
"@invariant-app/proposer": patch
---

A list whose items are a choice is read through the choice's name, so what each item may be is compared rather than missed.

The items of a list are no longer drafted as a field added or removed. Such a draft compiled, and closure accepted it, because the predicted document then matched the new contract; what it did at runtime was delete every item of the list before an old caller saw it. A list that gained a kind of item is a `widen`, and one that lost a kind is a declared loss, neither of which is an `add` or a `remove`.
