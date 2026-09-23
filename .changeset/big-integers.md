---
"@invariant-app/runtime": patch
---

An integer past 2^53 now passes through an adapted body exactly as it was sent. A double rounds such integers, and the runtime read numbers as doubles unless the text had an exponent of three digits or a hundred digits in a row, so Qdrant's own suite, which sends a search `limit` of u64::MAX, reached the server as 18446744073709552000 and was refused. Sixteen digits in a row now take the exact path, in the Go engine too.
