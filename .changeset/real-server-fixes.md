---
"@invariant-app/verifier": patch
"@invariant-app/telemetry": patch
---

Found by running `check --full` on real servers. Scenarios made from a document are asked under the path its servers declare (Immich serves `/albums` at `/api/albums`, and answers anything else with its web app). The differential reads a media type as one: `text/plain;charset=utf-8` and `text/plain; charset=utf-8` no longer count as a difference. The telemetry package no longer depends on the CLI for a test, which made a build cycle once the CLI runs the proxy.
