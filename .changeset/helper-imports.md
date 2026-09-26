---
"@invariant-app/migrate-ts": patch
---

The exact conversion helpers are imported however the consumer imports the SDK. A file that takes only the SDK's default export (`import Acme from "acme"`) gets them in braces beside it, and one that holds the SDK as a namespace, or names its types only with `import type`, gets an import of its own. Before, the first two were left calling `fromMinorUnits` with nothing imported, and the third had it added to the type-only import, where calling it does not compile.
