---
"@invariant-app/migrate-ts": minor
---

A TypeScript migration now rewrites more of what the Changes determine, where it used to leave the site or only show it:

- A field the response type inherits from a base interface, as `email` on a `Customer` that extends `CustomerBase`, is found and rewritten where the value is certainly the response type. A read from a value that is only the base, which other types may share, is shown.
- A renamed enum value is rewritten as a `case` of a `switch` over the field, in a list the field is looked for in (`["active", "past_due"].includes(customer.status)`), and wherever it is compared with a value of the SDK's own vocabulary type (`CustomerStatus`), as inside the consumer's own helper that takes one.
- A renamed field read by a string key from the SDK's object, `customer["nickname"]`, is renamed inside the string.
- Request parameters gathered in a `const` object that is only ever passed where the SDK's request type is expected have their renamed key rewritten, and a field read from an untyped parameter every call passes the SDK's object to is rewritten. Where either is not certain, the site is still shown.
- A field destructured with a default from untyped JSON is shown.
- A tagged stand-in's entry is no longer shown once the typed rewrite has already fixed it.
