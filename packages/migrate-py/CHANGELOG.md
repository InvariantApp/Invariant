# @invariant-app/migrate-py

## 0.5.0

### Minor Changes

- 44e1f3b: A Python migration now rewrites more of what the Changes determine, where it used to show the site to a person:
  
  - An amount now in minor units is converted with the SDK's own exact helpers: a read becomes `acme.from_minor_units(customer.balance)`, a value sent becomes `acme.to_minor_units(credit * 2)`, and a literal is converted on its digits, so `balance=Decimal("12.50")` becomes `balance=1250`. The helpers are named the way the file already names the SDK, through `import acme` or by extending its `from acme import ...`, and only once the checker confirms the SDK exports them. A read from a value that may be None is still shown, since what the absent case becomes is the consumer's choice.
  - A request field that became required, with the value it always had when left out, is written into each call and dictionary the checker says builds that request.
  - A request field that moved into a nested object is written as that object, `phone=mobile` becoming `contact={"phone": mobile}`, unless the call already passes it.
  - The cases of a `match` over a field whose values were renamed are renamed, and so is a class pattern's keyword for a renamed field (`case acme.Address(postcode=zip_code)`), where the checker resolves the pattern's class to the SDK's.
  - A renamed value is also rewritten where it is compared with the field as text (`str(customer.status) == "active"`), and where it is compared with a parameter the consumer annotated with the SDK's own type for the field's values, as a helper that takes an `acme.CustomerStatus`, when every call to it passes the field the Change covers. A parameter that is also passed something else is shown.
  - A renamed key of a dictionary built from literals and unpacked into the SDK's call (`create(**params)`) is rewritten, where the checker, reading the unpacking as keywords, says the key is the field, and the dictionary is used for nothing else.
  - A test's stand-in built with the response's class is shown where the response gained a field it lacks.
  - A key read from a dictionary the code binds only to literals it writes out, such as its own table of labels, is no longer shown as a possible read of the API's JSON.
  
  `@invariant-app/migrate-core` exports `exactMinorUnits`, the exact literal conversion every language pack shares.
- af96b68: The Python pack reads more of what the type checker cannot see.
  
  A value the checker cannot type is followed back through the consumer's own code: an assignment, the argument every call in the project passes to an unannotated parameter, what a function of the consumer's returns, a key read from a value already followed, and `to_dict()`. Where the trail ends at a call into the SDK that says what it returns, a field read from it by name (`sub["cancel_at"]`, `sub.get("cancel_at")`) is certainly that class's: a field renamed in place is rewritten there, and one followed to another class is no longer reported. A field the old release does not declare is still found by name where the value is provably its class; and against an old release that ships no types, where nearly every value is one the checker cannot type, a field is read by name only from such a value.
  
  A dictionary of keyword arguments built before the call (`raw_request = {...}`, then `create(**raw_request)`) is checked key by key: the call is checked again with the keys written out as keywords, against both releases, and a key the new release refuses and the old one took is shown where it is written. Where the callee itself no longer type-checks, as `openai.Completion` in openai 1.0, the dictionary is shown whole beside the call. Each use of a name whose import the upgraded SDK no longer satisfies is shown, a call that builds one as the whole call. Across a release that first ships its types, a member one of the SDK's own classes does not declare (`session.stripe_id` in stripe-python 7) now counts as a break; one missing from a string, `None` or a class of the standard library still does not.
  
  Requests made with `requests` or `httpx` are read against the same Changes, given the API's operations in the symbol map's new `wire` (servers, and each operation's method, path and response schema): the keys a request sends are that operation's parameters, and the JSON its response parses to is that schema, so a renamed parameter or field is rewritten and a removed one is shown.
- 415673a: The Python pack finds values a parameter no longer takes, written as literals.
  
  An SDK declares a parameter's vocabulary, as openai-python's `model` is `Union[str, ChatModel]`, and a release that drops a value from it means the API retired that value. The checker never says so, since the parameter takes any text too. The pack now reads each parameter's vocabulary from both releases' declarations, the literal aliases it names and the literals written into its annotation, and a string literal the consumer sends as the SDK's own parameter, directly or through a name bound to it, is a site wherever the old release lists it and the new one does not: rewritten where a Change maps the value (`enumMap`), shown otherwise. A function of the consumer's that takes a parameter of the same name is left alone.
  
  `buildPlan` gathers these values from every Change into the plan's new `retiredValues`: each old value an `enumMap` renames, with what it is sent as now, and each value a `dropValues` leaves out of a list, whatever the Change is scoped to.
  
  A site shown to a person may say where the changed element itself is written, as `at`, where what it shows is wider: the read of a moved field inside the statement around it, the key a plain HTTP request sends, the name of a removed class inside the call that builds one. The Python and Go packs say so.

### Patch Changes

- 96ba46a: A migration no longer stops forever on a value that leads back to itself. Value flow handed a value met again while it was still being followed its own unfinished answer, and where the cycle passed through a question to the checker the run waited on itself with nothing left to happen: an openai-python upgrade with Changes never finished. Such a value now ends there, as one met before any question already did.
  
  A field no file of the consumer's spells is no longer looked up in the checker at all, since it is read and written only by its name; on an SDK with hundreds of Changes those lookups were nearly all of a run.
- c1f600c: A `match` or a comparison on a value whose SDK vocabulary gained values across the upgrade is now shown. Anthropic's `stop_reason` gained `compaction`; code that matched on the old values still type-checked and quietly handled the new one as none of them. Each release's literal aliases are read, and where every string a decision names is one of an alias's old values, at least two of them, and the alias gained values the decision does not name, each case naming its values is shown with the values it misses, since which case should take them is the consumer's choice. A comparison is shown where it is written.
- 82928ae: A plan's type in a nested package, such as `anthropic.types.beta.BetaMessage`, is now found. The pack probed each type after importing only its top-level package, and pyright does not load a subpackage nobody imported, so every type below `anthropic.types` resolved to nothing and its fields were never looked up. The probe now imports the type's whole module path, the segments before its first class; a nested class such as `stripe.Subscription.AutomaticTax` still imports `stripe`.
- Updated dependencies [44e1f3b]
- Updated dependencies [af96b68]
- Updated dependencies [415673a]
  - @invariant-app/migrate-core@0.5.0
  - @invariant-app/ir@0.5.0

## 0.4.0

### Minor Changes

- c6d1cac: A fixture nothing types is read as the schema it says it is. Stripe tags every object it sends with its type, `"object": "invoice"`, and a recorded webhook or a test's stand-in copies the tag with everything else; given `tags` in the symbol map, every pack now shows a person each entry of such a literal that a Change removed or moved from its schema, and each event recorded at the API version the consumer's SDK spoke before the upgrade (its `api_version`), which the upgrade moves; one recorded long before was left behind already, and is not shown. The literal is read the same way in every language, as JSON in a Go raw string, a Python dictionary or a TypeScript object, and is never rewritten: what a fixture should hold instead is the API's answer, not an edit of the old one. `taggedObjectSites` and `goneFields` are exported from `@invariant-app/migrate-core` for a pack of its own.

### Patch Changes

- 1ba578b: The TypeScript pack checks the migrated consumer against the release it moves to, as the Python and Go packs do. Given `upgraded`, where the new release resolves from, it type-checks the consumer's files as they were against the release used today and as the edits left them against the new one, and shows a person each error the upgrade brought, with the checker's own words and the whole statement it is in: a field the new API version no longer sends, a parameter a method stopped taking, a fixture that no longer fits the type it claims. JavaScript is checked the same way, as `checkJs` would, and only what is new is reported. `checkFor` bounds the check in time where the type checker offers to stop, and `checker` runs each check where the caller can stop it outright, such as in a worker it ends at the deadline; a file the check did not reach is listed in the result's `unchecked` rather than holding the migration, and `trace` is told each step as it finishes. The engine itself still starts no process and no thread. `originalOffset`, which places an error in the edited text back where it was read, moves to `@invariant-app/migrate-core` for every pack, and is still exported from `@invariant-app/migrate-py`.
  
  A field a Change moved or removed is also shown where only its name says it may be the contract's: a key of an object literal nothing types, as a test's stand-in for a subscription handed to a mock, or a read or subscript of a value typed `any`, as a webhook's payload. Such a place is never rewritten, as the Python pack does with a dictionary's keys; a use typed as anything else is the checker's to decide.
- Updated dependencies [6edee60]
- Updated dependencies [cba62b1]
- Updated dependencies [d9ab966]
- Updated dependencies [407f319]
- Updated dependencies [c6d1cac]
- Updated dependencies [1ba578b]
- Updated dependencies [f2f666a]
- Updated dependencies [ca7c00e]
  - @invariant-app/ir@0.4.0
  - @invariant-app/migrate-core@0.4.0

## 0.3.0

### Patch Changes

- @invariant-app/ir@0.3.0
  - @invariant-app/migrate-core@0.3.0

## 0.2.0

### Minor Changes

- 7aa6dbe: Python consumers can be migrated. `@invariant-app/migrate-py` reads a Python repository against the SDK release it uses today, through pyright for what each name refers to and tree-sitter for what the code does with it, and writes the edits the Changes determine: a renamed field wherever it is read, set, passed by keyword or written as a key the type checker ties to the SDK, and a renamed value where a field is compared with it. A removed field, a subscript or `.get()` by a field's name, a read the checker cannot type, an expansion (`expand=["latest_invoice.payment_intent"]`) through a removed field and every API version pin (`stripe.api_version`, `stripe_version=`) are reported to a person, never edited. The result is then checked against the release being moved to, and every place that stops type-checking is reported with the checker's words, whether or not a Change named it, including a `match` a newly added value leaves incomplete and the consumer's own copy of values the SDK widened.
  
  The SDK and what its metadata requires are installed from wheels only, unpacked and checked against the digest the index publishes; a release with no wheel is refused rather than built. pyright is never pointed at an interpreter, so nothing of the consumer's, and no Python at all, is run.
  
  `@invariant-app/migrate-core` holds what every language pack shares: the migration plan, byte-range edits, the sites shown to a person and how a re-encoding is described. `@invariant-app/migrate-ts` re-exports them, so nothing that imports them from there changes.

### Patch Changes

- Updated dependencies [4f55bba]
- Updated dependencies [a530d28]
- Updated dependencies [9302f20]
- Updated dependencies [ea463aa]
- Updated dependencies [1e2171a]
- Updated dependencies [7aa6dbe]
- Updated dependencies [48948ea]
- Updated dependencies [d712bcf]
  - @invariant-app/ir@0.2.0
  - @invariant-app/migrate-core@0.2.0
