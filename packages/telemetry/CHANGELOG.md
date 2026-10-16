# @invariant-app/telemetry

## 0.5.0

### Patch Changes

- 57f9a09: Found by running `check --full` on real servers. Scenarios made from a document are asked under the path its servers declare (Immich serves `/albums` at `/api/albums`, and answers anything else with its web app). The differential reads a media type as one: `text/plain;charset=utf-8` and `text/plain; charset=utf-8` no longer count as a difference. The telemetry package no longer depends on the CLI for a test, which made a build cycle once the CLI runs the proxy.
- Updated dependencies [eeeb512]
  - @invariant-app/runtime@0.5.0
  - @invariant-app/client@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [5da65b3]
- Updated dependencies [407f319]
- Updated dependencies [ca7c00e]
  - @invariant-app/runtime@0.4.0
  - @invariant-app/client@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [9dc889d]
  - @invariant-app/runtime@0.3.0
  - @invariant-app/client@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [a136b88]
- Updated dependencies [a530d28]
- Updated dependencies [0823e06]
- Updated dependencies [ea463aa]
- Updated dependencies [60a6ebf]
- Updated dependencies [80b2b43]
  - @invariant-app/runtime@0.2.0
  - @invariant-app/client@0.2.0
