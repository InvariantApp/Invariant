---
"@invariant-app/runtime": patch
---

A number in an adapted body now passes through exactly as it was written, unless an instruction changes it. The runtime read numbers as doubles and wrote them back the shortest way, so an integer past 2^53 was rounded (Qdrant's suite sends a search `limit` of u64::MAX, which reached the server as 18446744073709552000 and was refused) and `1.0` came out as `1` (Qdrant tells a multivector from other inputs by how its numbers are written). A body with sixteen digits in a row, a fraction ending in zero, an exponent or a negative zero now takes the exact path, in the Go engine too.
