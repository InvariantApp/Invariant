---
"@invariant-app/migrate-go": minor
---

A Go migration now rewrites more of what the Changes determine, where it used to show every reference to the field:

- A value the contract renamed is rewritten wherever the type checker gives a string literal the SDK's named type for it (`CustomerStatus`): compared with the field, sent in a request, a case of a switch, listed in a `[]CustomerStatus`, or compared inside the consumer's own helper that takes one. A literal of plain `string` is left alone.
- An amount now in minor units is converted with the SDK's exact helpers, named in the symbol map's new `helpers` and checked against both releases: `sdk.FromMinorUnits(customer.Balance)` where it is read, `sdk.ToMinorUnits(credit * 2)` where it is sent, and a literal on its digits, `Balance: 1250`. A read from a variable the function checks for nil is still shown, since what the absent case becomes is the consumer's choice.
- A field that moved into an object of its struct is read through it (`customer.Contact.Phone`) and written into a literal of it (`Contact: &sdk.Contact{Phone: mobile}`).
- A request field that became required, with the value it always had, is written into each literal that builds the request, and a literal standing in for a response that gained a field is shown.
- A field an embedded struct promotes is found through the struct that embeds it, and a field named through reflection on the SDK's struct (`FieldByName("Nickname")`) is renamed.
- A key read from untyped JSON (`map[string]any`) that names a moved, removed or re-encoded field is shown, in files that use the SDK.
