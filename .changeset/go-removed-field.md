---
"@invariant-app/migrate-go": minor
---

A value the consumer writes to a field the upgraded SDK no longer has is followed to where it is made, as a rejected argument already was. slack-go's reactions listing moved from pages to cursors, and `Page: page` in a helper's options no longer compiled; the helper's `page` parameter and every call that passes one in are now shown with it, since each has to change with the field.
