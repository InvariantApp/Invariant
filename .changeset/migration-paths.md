---
"@invariant-app/migrate-ts": patch
---

A migration writes only inside the repository it migrates. The helpers module a symbol map asks for and the generated files a run replaces are refused before anything is read if their path is absolute or climbs out, where `../` was written wherever it pointed. Before the first file is written, every destination, `package.json` included, is checked with links followed, so a file committed as a link to another checkout is refused rather than written through, and a file is judged inside the repository by its path rather than by a prefix, so `/work/repo` no longer counts `/work/repo-other` as its own. The refusal is a `MigrationPathError`, and a refused run leaves the repository as it was.
