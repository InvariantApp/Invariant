---
"@invariant-app/migrate-py": minor
"@invariant-app/migrate-core": minor
---

A Python migration now rewrites more of what the Changes determine, where it used to show the site to a person:

- An amount now in minor units is converted with the SDK's own exact helpers: a read becomes `acme.from_minor_units(customer.balance)`, a value sent becomes `acme.to_minor_units(credit * 2)`, and a literal is converted on its digits, so `balance=Decimal("12.50")` becomes `balance=1250`. The helpers are named the way the file already names the SDK, through `import acme` or by extending its `from acme import ...`, and only once the checker confirms the SDK exports them. A read from a value that may be None is still shown, since what the absent case becomes is the consumer's choice.
- A request field that became required, with the value it always had when left out, is written into each call and dictionary the checker says builds that request.
- A request field that moved into a nested object is written as that object, `phone=mobile` becoming `contact={"phone": mobile}`, unless the call already passes it.
- The cases of a `match` over a field whose values were renamed are renamed, and so is a class pattern's keyword for a renamed field (`case acme.Address(postcode=zip_code)`), where the checker resolves the pattern's class to the SDK's.
- A renamed value is also rewritten where it is compared with a name the consumer annotated with the SDK's own type for the field's values, as inside a helper that takes a `acme.CustomerStatus`.
- A renamed key of a dictionary built from literals and unpacked into the SDK's call (`create(**params)`) is rewritten, where the checker, reading the unpacking as keywords, says the key is the field, and the dictionary is used for nothing else.
- A test's stand-in built with the response's class is shown where the response gained a field it lacks.
- A key read from a dictionary the code binds only to literals it writes out, such as its own table of labels, is no longer shown as a possible read of the API's JSON.

`@invariant-app/migrate-core` exports `exactMinorUnits`, the exact literal conversion every language pack shares.
