---
"@invariant-app/ir": minor
"@invariant-app/compiler": minor
"@invariant-app/runtime": minor
"@invariant-app/proposer": minor
"@invariant-app/migrate-core": patch
"@invariant-app/diff": patch
---

A new codec, `dropValues {values}`, for a list whose items no longer accept some values an old caller may send: the values are left out of the list on the way in and the rest is served, a loss the Change declares. Asana took a hundred and twenty-six fields out of what a portfolio's items may be asked to include, and an old caller asking for `opt_fields=color` was refused outright; the proposer now drafts this for a list parameter whose values only went, and asks where others arrived beside them. Runtimes run it as the new `drop` instruction, in the Go engine too. A feature added since the last release is now entered as `NEXT` and asks for a pre-release of the next patch, which every published runtime refuses with the error naming a newer one, until the release that ships it replaces `NEXT` with its version.
