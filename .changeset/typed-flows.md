---
"@invariant-app/migrate-ts": minor
---

A stand-in for a response in a file that never imports the SDK is shown to a person where the types say it is handed to the SDK's type. hiroppy's web-app-template tests its subscription handler with `const subscription = { current_period_end: null, ... }` and `handleSubscriptionUpsert(subscription)`, whose parameter is a `Stripe.Subscription`, the mismatch silenced by `@ts-expect-error`; the field it holds is one the upgrade moved. It is never rewritten: what the test means its stand-in to hold, the types do not say.
