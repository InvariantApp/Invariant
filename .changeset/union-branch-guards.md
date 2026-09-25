---
"@invariant-app/contract": patch
---

A Change is placed inside a union whose branches are themselves unions, as Stripe's `payout.destination` is an id, an `external_account` (a bank account or a card) or a `deleted_external_account` (either, deleted). What such a branch requires is now what every one of its alternatives requires, and what it may hold is what any of them declares, so the live side is told apart by `has: country` and the deleted side by `has: deleted`, where before the site was refused as one nothing tells apart. Stripe's `payment_intent.source` is placed the same way. A plain branch is judged as before.
