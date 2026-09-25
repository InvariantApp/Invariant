---
"@invariant-app/migrate-py": minor
"@invariant-app/migrate-core": minor
"@invariant-app/migrate-go": patch
---

The Python pack finds values a parameter no longer takes, written as literals.

An SDK declares a parameter's vocabulary, as openai-python's `model` is `Union[str, ChatModel]`, and a release that drops a value from it means the API retired that value. The checker never says so, since the parameter takes any text too. The pack now reads each parameter's vocabulary from both releases' declarations, the literal aliases it names and the literals written into its annotation, and a string literal the consumer sends as the SDK's own parameter, directly or through a name bound to it, is a site wherever the old release lists it and the new one does not: rewritten where a Change maps the value (`enumMap`), shown otherwise. A function of the consumer's that takes a parameter of the same name is left alone.

`buildPlan` gathers these values from every Change into the plan's new `retiredValues`: each old value an `enumMap` renames, with what it is sent as now, and each value a `dropValues` leaves out of a list, whatever the Change is scoped to.

A site shown to a person may say where the changed element itself is written, as `at`, where what it shows is wider: the read of a moved field inside the statement around it, the key a plain HTTP request sends, the name of a removed class inside the call that builds one. The Python and Go packs say so.
