---
"@invariant-app/migrate-py": minor
"@invariant-app/migrate-core": minor
---

The Python pack reads more of what the type checker cannot see.

A value the checker cannot type is followed back through the consumer's own code: an assignment, the argument every call in the project passes to an unannotated parameter, what a function of the consumer's returns, a key read from a value already followed, and `to_dict()`. Where the trail ends at a call into the SDK that says what it returns, a field read from it by name (`sub["cancel_at"]`, `sub.get("cancel_at")`) is certainly that class's: a field renamed in place is rewritten there, and one followed to another class is no longer reported. A field the old release does not declare is still found by name where the value is provably its class; and against an old release that ships no types, where nearly every value is one the checker cannot type, a field is read by name only from such a value.

A dictionary of keyword arguments built before the call (`raw_request = {...}`, then `create(**raw_request)`) is checked key by key: the call is checked again with the keys written out as keywords, against both releases, and a key the new release refuses and the old one took is shown where it is written. Where the callee itself no longer type-checks, as `openai.Completion` in openai 1.0, the dictionary is shown whole beside the call. Each use of a name whose import the upgraded SDK no longer satisfies is shown, a call that builds one as the whole call. Across a release that first ships its types, a member one of the SDK's own classes does not declare (`session.stripe_id` in stripe-python 7) now counts as a break; one missing from a string, `None` or a class of the standard library still does not.

Requests made with `requests` or `httpx` are read against the same Changes, given the API's operations in the symbol map's new `wire` (servers, and each operation's method, path and response schema): the keys a request sends are that operation's parameters, and the JSON its response parses to is that schema, so a renamed parameter or field is rewritten and a removed one is shown.
