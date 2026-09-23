---
"@invariant-app/ir": minor
"@invariant-app/compiler": minor
"@invariant-app/proposer": minor
"@invariant-app/migrate-core": patch
"@invariant-app/diff": patch
---

Response vocabularies that grew or opened are drafted where the documents say what happened. `dropValues` now leaves each value out of a list on its way to the side whose contract does not name it, so it serves responses too: Discord listed `event_webhooks_types` as a list of no values and then twelve, and an old caller is sent the list without them, a declared loss. A value the old list held is taken out of the predicted list and one it did not is added, and the backward `drop` is the instruction runtimes already run. A field that became a choice between the values it named and any other text, as Mistral's tool `name` did, is the vocabulary opening: a `relax` with `enum: null` and a `restate` that writes the choice as the new contract does. So is a named vocabulary that stopped listing its values, as Apicurio's `ArtifactType` did, declared once at the schema. A field whose values moved between being listed in place and being a named schema's is compared by the values it holds, so Okta's custom role type, which went from `CUSTOM` alone to every role type there is, is asked about as a fold; one that stopped referring to a vocabulary that itself changed is left to that vocabulary's own Change, which already runs there. An `enumMap` reads `const: x` as the one value it lists.
