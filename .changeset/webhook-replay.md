---
"@invariant-app/github": patch
---

`verifyWebhook` remembers each delivery's body as well as its delivery id. GitHub signs the body and nothing else, so a captured delivery sent again under a fresh `X-GitHub-Delivery`, or under another event's name, carried a valid signature and was handled a second time; it is now answered as already handled. `deliverMigration` refuses a file path that is absolute, climbs with `..`, holds an empty segment or a backslash, or writes into `.git`, before it calls GitHub at all.
