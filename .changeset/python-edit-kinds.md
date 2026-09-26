---
"@invariant-app/migrate-py": minor
"@invariant-app/migrate-core": minor
---

A Python migration now rewrites more of what the Changes determine, where it used to show the site to a person:

- An amount now in minor units is converted with the SDK's own exact helpers: a read becomes `acme.from_minor_units(customer.balance)`, a value sent becomes `acme.to_minor_units(credit * 2)`, and a literal is converted on its digits, so `balance=Decimal("12.50")` becomes `balance=1250`. The helpers are named the way the file already names the SDK, through `import acme` or by extending its `from acme import ...`, and only once the checker confirms the SDK exports them. A read from a value that may be None is still shown, since what the absent case becomes is the consumer's choice.
- A request field that became required, with the value it always had when left out, is written into each call and dictionary the checker says builds that request.
- A request field that moved into a nested object is written as that object, `phone=mobile` becoming `contact={"phone": mobile}`, unless the call already passes it.
- The cases of a `match` over a field whose values were renamed are renamed, and so is a class pattern's keyword for a renamed field (`case acme.Address(postcode=zip_code)`), where the checker resolves the pattern's class to the SDK's.
- A test's stand-in built with the response's class is shown where the response gained a field it lacks.

`@invariant-app/migrate-core` exports `exactMinorUnits`, the exact literal conversion every language pack shares.
