---
"@invariant-app/diff": patch
---

A diff too large to hold is refused as one, rather than crashing the process. The differ's output was read with a 512 MiB limit, just above the longest string Node can hold, so output between the two was joined past it inside Node's own exit handler, where no caller could catch the error. The limit is now 500 MiB, and a diff beyond it fails as a child-process error the caller sees.
