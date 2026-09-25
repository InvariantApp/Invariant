---
"@invariant-app/migrate-py": patch
---

A plan's type in a nested package, such as `anthropic.types.beta.BetaMessage`, is now found. The pack probed each type after importing only its top-level package, and pyright does not load a subpackage nobody imported, so every type below `anthropic.types` resolved to nothing and its fields were never looked up. The probe now imports the type's whole module path, the segments before its first class; a nested class such as `stripe.Subscription.AutomaticTax` still imports `stripe`.
