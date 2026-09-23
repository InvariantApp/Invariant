---
"@invariant-app/compiler": patch
"@invariant-app/proposer": patch
"@invariant-app/contract": patch
---

A restatement is written into the prediction exactly as the new contract writes it, with its names, and is refused where it refers to a schema the old contract states differently, since written there it would mean the old statement rather than what was proved. Plaid's account identity re-declares its base's mask in an `allOf`, and merged here it was reconciled differently from how the differ reads it, leaving fifty-odd places that became nullable in a release where none had. `referencesAlike` in `@invariant-app/contract` is the check. The proposer also no longer restates a place whose choices changed only in their descriptions.
