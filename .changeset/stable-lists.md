---
"@invariant-app/diff": patch
---

A differ run that lists values in a different order no longer reads as a different answer. oasdiff writes the values a change added or removed in the order it walked a Go map and hashes that text into its fingerprint, so Figma's discriminator mappings came back as `NOISE, TEXTURE` and then `TEXTURE, NOISE`, and a confirmed comparison of two identical answers was refused as not reproducible. Lists in an entry's text are sorted, and its fingerprint is taken from what it says.
