---
"@invariant-app/verifier": minor
"@invariant-app/cli": minor
---

Scenarios from traffic a provider already recorded. `invariant scenarios import <file> --label <c>` reads a HAR file or a Postman collection into `invariant/scenarios`: one scenario per HAR page or top-level Postman folder, in the order the requests were sent, with each value an earlier answer minted captured and referred to where a later request sends it again, so a fresh build is sent its own ids. A Postman test script that sets a variable from the response becomes the same capture. Recorded credentials and headers that describe the recording are dropped, `--base` keeps only the API's requests, and a request that cannot be replayed faithfully, a body that is not JSON or a variable only a script could have set, is left out and named. A file already in `invariant/scenarios` is never overwritten. The verifier exports `scenariosFromHar` and `scenariosFromPostman`.
