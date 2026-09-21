# @invariant/oasdiff-win32-arm64

The unmodified [oasdiff](https://github.com/oasdiff/oasdiff) release binary for
win32-arm64, so the Invariant release gate needs no Go toolchain. It is installed
automatically as an optional dependency of `@invariant/diff` on the platform it
is for, and is never needed directly.

The binary is upstream's release asset, checked against upstream's published
checksums and against a hash committed in the Invariant repository before it is
packed. oasdiff is licensed under the Apache License, Version 2.0; its licence
is included as LICENSE.
