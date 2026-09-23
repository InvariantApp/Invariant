# @invariant-app/github

## 0.3.0

### Patch Changes

- @invariant-app/bundle@0.3.0
  - @invariant-app/migrate-ts@0.3.0
  - @invariant-app/ir@0.3.0

## 0.2.0

### Patch Changes

- 80b2b43: `verifyWebhook` remembers each delivery's body as well as its delivery id. GitHub signs the body and nothing else, so a captured delivery sent again under a fresh `X-GitHub-Delivery`, or under another event's name, carried a valid signature and was handled a second time; it is now answered as already handled. `deliverMigration` refuses a file path that is absolute, climbs with `..`, holds an empty segment or a backslash, or writes into `.git`, before it calls GitHub at all.
- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [80b2b43]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [7aa6dbe]
- Updated dependencies [48948ea]
- Updated dependencies [d712bcf]
  - @invariant-app/ir@0.2.0
  - @invariant-app/migrate-ts@0.2.0
  - @invariant-app/bundle@0.2.0
