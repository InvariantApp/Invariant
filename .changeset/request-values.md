---
"@invariant-app/proposer": minor
"@invariant-app/compiler": patch
"@invariant-app/diff": patch
---

A request field that no longer accepts some values old callers send is drafted rather than left as an open question: a list's items get `dropValues`, and a single value is one decision, which value that remains the one that went is sent as, with the likeliest suggested. Adyen, Plaid and PayPal retired request values this way. Where the field is used both ways, the compiler reads two old values that became one back as the value that remains, since the API can no longer produce the one that went. And a text schema whose enum is written as numbers is compared as the text they are written as: Plaid wrote its Prism versions as `type: string, enum: [4.1, 4, 3]` and a release later as text, which the differ reported as thirty-three values removed.
