---
"@invariant-app/proposer": patch
"@invariant-app/compiler": patch
"@invariant-app/diff": patch
"@invariant-app/verifier": patch
---

Six changes between two Stripe releases that the gate drafted wrongly, could not draft, or refused although they were served.

- A response that was a choice between schemas and now gives only kinds it could already give is no change. Stripe's terminal reader `cancel_action` went from a reader or a deleted reader to a reader, and every field of the reader was drafted as new and taken out of old callers' answers; the differ, reading the choice as an object with no fields, reported each as a required property added.
- An id that became expandable, as Stripe made the `mandate` of a card payment an id or the mandate, is drafted as a `widen` showing old callers the id, and `widen` now writes a field that was plain text as the union, the id's bounds on its text branch.
- A value that became an object holding it under its one required field, as `billing_cycle_anchor` on resuming a subscription became `{ type }`, is drafted as a `move` beneath its own place, and the prediction keeps the value required inside the object built from it.
- A request field whose new list of values the specification marks `x-stripeBypassValidation`, or an open `x-stripeEnum`, is not reported as refusing old callers' values, since the server does not hold callers to the list.
- The lens laws excuse a declared loss wherever the value holds the schema that declared it, found by walking the value, rather than only at the places the compiler lists, which stop where a recursive schema would enter itself. A loss ending at a list's items covers the list, so a fold on the values of a list holds. Folds on Stripe's `payment_method_types` and on a payment method's `type` reached through a setup attempt were refused for the loss they declared.
- The laws run the transform on values of any size; a generated Stripe object past the runtime's default megabyte was reported as a Change that could not be undone.
