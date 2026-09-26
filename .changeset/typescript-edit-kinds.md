---
"@invariant-app/migrate-ts": minor
---

A TypeScript migration now rewrites more of what the Changes determine, where it used to leave the site or only show it:

- A field the response type inherits from a base interface, as `email` on a `Customer` that extends `CustomerBase`, is found and rewritten where the value is certainly the response type. A read from a value that is only the base, which other types may share, is shown.
- A renamed enum value is rewritten as a `case` of a `switch` over the field, in a list the field is looked for in (`["active", "past_due"].includes(customer.status)`), compared with the field as text (`String(customer.status) === "active"`), and wherever it is compared with a value of the SDK's own vocabulary type (`CustomerStatus`) that comes only from the field the Change covers, as inside the consumer's own helper every call to which passes that field. An SDK that gives a response's field and a request's the same type keeps the other side's values as they are, and a value that cannot be followed to a field, or meets both, is shown.
- A renamed field read by a string key from the SDK's object, `customer["nickname"]`, is renamed inside the string.
- Request parameters gathered in a `const` object that is only ever passed where the SDK's request type is expected have their renamed key rewritten, and a field read from an untyped parameter every call passes the SDK's object to is rewritten. Where either is not certain, the site is still shown.
- A tagged stand-in's entry is no longer shown once the typed rewrite has already fixed it.
