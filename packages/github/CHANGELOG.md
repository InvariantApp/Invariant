# @invariant-app/github

## 0.5.0

### Patch Changes

- Updated dependencies [d9cad85]
- Updated dependencies [2308653]
- Updated dependencies [8f3e365]
- Updated dependencies [eeeb512]
- Updated dependencies [5fed925]
  - @invariant-app/bundle@0.5.0
  - @invariant-app/migrate-ts@0.5.0
  - @invariant-app/ir@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [6edee60]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [c6d1cac]
- Updated dependencies [c6d1cac]
- Updated dependencies [1ba578b]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/migrate-ts@0.4.0
  - @invariant-app/bundle@0.4.0

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
