---
"@invariant-app/cli": patch
---

`invariant observe` reads a compressed answer (gzip, deflate, brotli) the way its caller does. It checked the compressed bytes before, so a server that compresses what a client asks it to, as Jellyfin does, had every answer counted as one nothing could check. The CLI exports `observe` and `renderObservation`.
