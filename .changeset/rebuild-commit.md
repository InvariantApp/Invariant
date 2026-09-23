---
"@invariant-app/cli": patch
---

`invariant verify --rebuild` refuses a bundle whose source commit is not a commit id before handing it to git, where a signed `--orphan=x` would have been read as an option.
