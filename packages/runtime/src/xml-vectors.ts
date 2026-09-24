/**
 * The golden vectors for XML bodies: a site's description of one, its
 * instructions, a body as a caller sends it, and the body that has to come
 * out, or what has to refuse it: `decode` for a description no runtime may
 * load, `body` for XML no runtime may read, `too-large` for a body past a
 * limit, and otherwise the change that refuses it.
 */
import type { Instr, XmlBody, XmlNode } from "@invariant-app/ir";

export interface XmlVector {
  name: string;
  why: string;
  xml: XmlBody;
  instrs: Instr[];
  input: string;
  expect: { output: string } | { refuses: string };
}

const C = "chg_vector";

const object = (properties: Record<string, XmlNode>, extra: Partial<XmlNode> = {}) =>
  ({ type: "object", properties, ...extra }) as XmlNode;
const text: XmlNode = { type: "string" };
const both = (read: XmlNode, write: XmlNode = read): XmlBody => ({ read, write });

/** CloudFront's list of distributions, as its contract describes it. */
const distributions = object({
  DistributionList: object({
    Items: {
      type: "array",
      wrapped: true,
      items: object({ Status: text }, { name: "DistributionSummary" }),
    },
  }),
});

export const XML_VECTORS: XmlVector[] = [
  {
    name: "a document nothing changes comes out byte for byte",
    why: "Re-encoding what no Change touched would change bytes someone may depend on: the declaration, comments, quotes, references and indentation all stay.",
    xml: both(object({ Status: text })),
    instrs: [
      { k: "enum", path: "/Status", map: { done: "done", queued: "accepted" }, c: C },
    ],
    input:
      "<?xml version='1.0' encoding='UTF-8'?>\n<!-- a comment -->\n<Order id='7' note=\"a &amp; b\">\n  <Status>done</Status>\n  <Note><![CDATA[<b>x</b>]]></Note>\n  <?keep me?>\n</Order>\n",
    expect: {
      output:
        "<?xml version='1.0' encoding='UTF-8'?>\n<!-- a comment -->\n<Order id='7' note=\"a &amp; b\">\n  <Status>done</Status>\n  <Note><![CDATA[<b>x</b>]]></Note>\n  <?keep me?>\n</Order>\n",
    },
  },
  {
    name: "a value is mapped in place",
    why: "An enum rename is the same instruction in XML as in JSON, and only the element's text changes.",
    xml: both(object({ Status: text })),
    instrs: [{ k: "enum", path: "/Status", map: { queued: "accepted" }, c: C }],
    input: "<Order>\n  <Status>queued</Status>\n  <Total>10</Total>\n</Order>",
    expect: {
      output: "<Order>\n  <Status>accepted</Status>\n  <Total>10</Total>\n</Order>",
    },
  },
  {
    name: "a value in every item of a wrapped list is mapped",
    why: "CloudFront lists distributions inside an <Items> wrapper, each item named for its type, and a vocabulary change reaches each one.",
    xml: both(distributions),
    instrs: [
      {
        k: "within",
        path: "/DistributionList/Items/*",
        block: [
          {
            k: "enum",
            path: "/Status",
            map: { Deployed: "Deployed", InProgress: "Deploying" },
            c: C,
          },
        ],
        c: C,
      },
    ],
    input:
      '<ListDistributionsResult xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><DistributionList><Marker/><Items><DistributionSummary><Id>E1</Id><Status>InProgress</Status></DistributionSummary><DistributionSummary><Id>E2</Id><Status>Deployed</Status></DistributionSummary></Items></DistributionList></ListDistributionsResult>',
    expect: {
      output:
        '<ListDistributionsResult xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/"><DistributionList><Marker/><Items><DistributionSummary><Id>E1</Id><Status>Deploying</Status></DistributionSummary><DistributionSummary><Id>E2</Id><Status>Deployed</Status></DistributionSummary></Items></DistributionList></ListDistributionsResult>',
    },
  },
  {
    name: "items of a list written in place keep their places among other elements",
    why: "An unwrapped list's items are siblings of other fields, and each is written back where it stood.",
    xml: both(object({ Tag: { type: "array", items: { type: "string", name: "Tag" } } })),
    instrs: [{ k: "enum", path: "/Tag/*", map: { a: "A", b: "B" }, c: C }],
    input: "<Post><Tag>a</Tag><Title>t</Title><Tag>b</Tag></Post>",
    expect: { output: "<Post><Tag>A</Tag><Title>t</Title><Tag>B</Tag></Post>" },
  },
  {
    name: "a field a new contract requires is supplied before the end tag's indent",
    why: "A default an old caller never sent, written where the document's own layout puts a last child.",
    xml: both(object({ EventType: text })),
    instrs: [
      { k: "set", path: "/EventType", value: "viewer-request", ifAbsent: true, c: C },
    ],
    input: "<Association>\n  <Arn>arn:1</Arn>\n</Association>",
    expect: {
      output:
        "<Association>\n  <Arn>arn:1</Arn><EventType>viewer-request</EventType>\n</Association>",
    },
  },
  {
    name: "a default is not written over a value the caller sent",
    why: "`ifAbsent` is the same promise in XML: what the caller wrote stays.",
    xml: both(object({ EventType: text })),
    instrs: [
      { k: "set", path: "/EventType", value: "viewer-request", ifAbsent: true, c: C },
    ],
    input: "<Association><EventType>origin-request</EventType></Association>",
    expect: {
      output: "<Association><EventType>origin-request</EventType></Association>",
    },
  },
  {
    name: "a field is written into an element that was empty",
    why: "`<Config/>` has no end tag to write before, so it gains one.",
    xml: both(object({ Enabled: { type: "boolean" } })),
    instrs: [{ k: "set", path: "/Enabled", value: false, ifAbsent: true, c: C }],
    input: '<Config id="1"/>',
    expect: { output: '<Config id="1"><Enabled>false</Enabled></Config>' },
  },
  {
    name: "an object is written with the names its contract gives it",
    why: "A default that is an object is written as elements, each named as the contract names it.",
    xml: both(
      object({ Forwarded: object({ QueryString: { type: "boolean", name: "QS" } }) }),
    ),
    instrs: [
      {
        k: "set",
        path: "/Forwarded",
        value: { QueryString: false },
        ifAbsent: true,
        c: C,
      },
    ],
    input: "<Behavior><Path>*</Path></Behavior>",
    expect: {
      output: "<Behavior><Path>*</Path><Forwarded><QS>false</QS></Forwarded></Behavior>",
    },
  },
  {
    name: "a field an old contract does not have is removed with what it holds",
    why: "Removing a field removes its element, whatever is inside it; the indentation around it stays.",
    xml: both(object({ Staging: text })),
    instrs: [{ k: "del", path: "/Staging", c: C }],
    input: "<Distribution>\n  <Id>E1</Id>\n  <Staging>false</Staging>\n</Distribution>",
    expect: { output: "<Distribution>\n  <Id>E1</Id>\n  \n</Distribution>" },
  },
  {
    name: "a renamed field is written under its new name, attributes and contents as they came",
    why: "A rename is the commonest change there is; an element's attributes and every child nothing names travel with it untouched.",
    xml: both(object({ Old: object({}) }), object({ New: object({}) })),
    instrs: [{ k: "move", from: "/Old", to: "/New", c: C }],
    input: '<Root><Old kind="a"><X>1</X><!-- kept --><Y/></Old><Z/></Root>',
    expect: { output: '<Root><Z/><New kind="a"><X>1</X><!-- kept --><Y/></New></Root>' },
  },
  {
    name: "a value moved into an object that was not there is written inside it",
    why: "A field that moved beneath a new parent creates the parent, named as the contract names it.",
    xml: both(object({ City: text }), object({ Address: object({ City: text }) })),
    instrs: [{ k: "move", from: "/City", to: "/Address/City", c: C }],
    input: "<Customer><Name>Ada</Name><City>Paris</City></Customer>",
    expect: {
      output:
        "<Customer><Name>Ada</Name><Address><City>Paris</City></Address></Customer>",
    },
  },
  {
    name: "an attribute's value is mapped",
    why: "A field the contract writes as an attribute is read and written as one.",
    xml: both(object({ status: { type: "string", attribute: true } })),
    instrs: [{ k: "enum", path: "/status", map: { on: "enabled" }, c: C }],
    input: "<Item id='1' status='on'><Name>n</Name></Item>",
    expect: { output: "<Item id='1' status=\"enabled\"><Name>n</Name></Item>" },
  },
  {
    name: "a new attribute is added to the start tag",
    why: "A default the contract writes as an attribute goes where attributes go.",
    xml: both(object({ version: { type: "integer", attribute: true } })),
    instrs: [{ k: "set", path: "/version", value: 2, ifAbsent: true, c: C }],
    input: "<Item id='1'/>",
    expect: { output: "<Item id='1' version=\"2\"/>" },
  },
  {
    name: "a number written as text is scaled exactly",
    why: "A value the contract types as a number reaches the instruction as one, digits and all.",
    xml: both(object({ Amount: { type: "number" } })),
    instrs: [{ k: "scale", path: "/Amount", exp: 2, c: C }],
    input: "<Charge><Amount>49.99</Amount></Charge>",
    expect: { output: "<Charge><Amount>4999</Amount></Charge>" },
  },
  {
    name: "a new element takes the default namespace it is written in",
    why: "Amazon writes every element in the namespace its root declares; a field the program adds is in it too, without a declaration of its own.",
    xml: both(object({ Comment: text })),
    instrs: [{ k: "set", path: "/Comment", value: "", ifAbsent: true, c: C }],
    input:
      '<Config xmlns="http://cloudfront.amazonaws.com/doc/2019-03-26/"><Enabled>true</Enabled></Config>',
    expect: {
      output:
        '<Config xmlns="http://cloudfront.amazonaws.com/doc/2019-03-26/"><Enabled>true</Enabled><Comment/></Config>',
    },
  },
  {
    name: "a new element in a declared namespace uses the prefix bound to it",
    why: "A description with a prefix and a namespace writes the prefix, declaring it only where it is not already bound.",
    xml: both(
      object({
        Note: { type: "string", prefix: "n", namespace: "urn:notes" },
        Tag: { type: "string", prefix: "t", namespace: "urn:tags" },
      }),
    ),
    instrs: [
      { k: "set", path: "/Note", value: "hi", ifAbsent: true, c: C },
      { k: "set", path: "/Tag", value: "x", ifAbsent: true, c: C },
    ],
    input: '<Doc xmlns:n="urn:notes"><Id>1</Id></Doc>',
    expect: {
      output:
        '<Doc xmlns:n="urn:notes"><Id>1</Id><n:Note>hi</n:Note><t:Tag xmlns:t="urn:tags">x</t:Tag></Doc>',
    },
  },
  {
    name: "an element matches its description only in the namespace it names",
    why: "Two elements with one local name in different namespaces are different fields; the one in another namespace is kept as it came.",
    xml: both(object({ Status: { type: "string", namespace: "urn:a" } })),
    instrs: [{ k: "enum", path: "/Status", map: { x: "y" }, c: C }],
    input:
      '<Doc xmlns:a="urn:a" xmlns:b="urn:b"><b:Status>x</b:Status><a:Status>x</a:Status></Doc>',
    expect: {
      output:
        '<Doc xmlns:a="urn:a" xmlns:b="urn:b"><b:Status>x</b:Status><a:Status>y</a:Status></Doc>',
    },
  },
  {
    name: "an element moved out of a namespace's scope keeps its namespace",
    why: "Moving an element from under a declaration to where the prefix is not bound would change what its contents mean, so the declaration goes with it.",
    xml: both(
      object({ Inner: object({ Part: object({}) }) }),
      object({ Part: object({}) }),
    ),
    instrs: [{ k: "move", from: "/Inner/Part", to: "/Part", c: C }],
    input: '<Doc><Inner xmlns:p="urn:p"><Part><p:x>1</p:x></Part><Other/></Inner></Doc>',
    expect: {
      output:
        '<Doc><Inner xmlns:p="urn:p"><Other/></Inner><Part xmlns:p="urn:p"><p:x>1</p:x></Part></Doc>',
    },
  },
  {
    name: "text a program writes is escaped",
    why: "A value holding markup characters must stay a value, never become markup.",
    xml: both(object({ Comment: text })),
    instrs: [
      { k: "set", path: "/Comment", value: "a < b & c > d]]>", ifAbsent: false, c: C },
    ],
    input: "<Config><Comment>old</Comment></Config>",
    expect: {
      output: "<Config><Comment>a &lt; b &amp; c &gt; d]]&gt;</Comment></Config>",
    },
  },
  {
    name: "references are read as the characters they stand for",
    why: "`&#x41;` and `&amp;` are the text `A&`, which is what a map compares.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { "A&": "B" }, c: C }],
    input: "<R><S>&#x41;&amp;</S></R>",
    expect: { output: "<R><S>B</S></R>" },
  },
  {
    name: "a value an instruction leaves as it was keeps how it was written",
    why: "A map that sends a value to itself changes nothing, so the reference it was written with stays.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { x: "x" }, c: C }],
    input: "<R><S>&#120;</S></R>",
    expect: { output: "<R><S>&#120;</S></R>" },
  },
  {
    name: "a line break is read as XML reads one",
    why: "A carriage return and line feed in text is one line feed to an XML reader, whatever the bytes.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { "a\nb": "c" }, c: C }],
    input: "<R><S>a\r\nb</S></R>",
    expect: { output: "<R><S>c</S></R>" },
  },
  {
    name: "a CDATA section is read as its text",
    why: "CDATA is text written without escaping, and means the same as the escaped text.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { "<b>": "bold" }, c: C }],
    input: "<R><S><![CDATA[<b>]]></S></R>",
    expect: { output: "<R><S>bold</S></R>" },
  },
  {
    name: "a byte order mark stays where it was",
    why: "Some servers write one; it is not part of the root element.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "\uFEFF<R><S>a</S></R>",
    expect: { output: "\uFEFF<R><S>b</S></R>" },
  },
  {
    name: "a value becomes a list of one written in place",
    why: "`wrap` makes a list, and a list written in place is its item repeated under the list's item name.",
    xml: both(
      object({ Email: text }),
      object({ Email: { type: "array", items: { type: "string", name: "Email" } } }),
    ),
    instrs: [{ k: "wrap", path: "/Email", c: C }],
    input: "<User><Email>a@x</Email></User>",
    expect: { output: "<User><Email>a@x</Email></User>" },
  },
  {
    name: "a list of one becomes its item",
    why: "`unwrap` stands the item where the list's first item stood.",
    xml: both(
      object({ Email: { type: "array", items: { type: "string", name: "Email" } } }),
      object({ Email: text }),
    ),
    instrs: [{ k: "unwrap", path: "/Email", c: C }],
    input: "<User><Email>a@x</Email><Name>n</Name></User>",
    expect: { output: "<User><Email>a@x</Email><Name>n</Name></User>" },
  },
  {
    name: "values the new contract refuses are taken out of a wrapped list",
    why: "`drop` removes items and leaves the others, and the wrapper's layout, as they were.",
    xml: both(
      object({
        Fields: {
          type: "array",
          wrapped: true,
          items: { type: "string", name: "Field" },
        },
      }),
    ),
    instrs: [{ k: "drop", path: "/Fields", values: ["legacy"], c: C }],
    input:
      "<Q><Fields>\n  <Field>id</Field>\n  <Field>legacy</Field>\n  <Field>name</Field>\n</Fields></Q>",
    expect: {
      output:
        "<Q><Fields>\n  <Field>id</Field>\n  <Field>name</Field>\n  \n</Fields></Q>",
    },
  },
  {
    name: "an item a list gains follows its last item",
    why: "A list written in place that grew keeps its items where they were and writes the new ones after the last.",
    xml: both(object({ Tag: { type: "array", items: { type: "string", name: "Tag" } } })),
    instrs: [{ k: "set", path: "/Tag", value: ["a", "new"], ifAbsent: false, c: C }],
    input: "<Post><Tag>a</Tag><Title>t</Title></Post>",
    expect: { output: "<Post><Tag>a</Tag><Tag>new</Tag><Title>t</Title></Post>" },
  },
  {
    name: "a place the writing description does not name keeps the names it had",
    why: "Only what a description names is renamed; a list read and left where it was keeps its items' names, found by the round-trip property.",
    xml: {
      read: object({
        Items: { type: "array", wrapped: true, items: { type: "string", name: "S" } },
      }),
      write: object({ A: object({ S: text }) }),
    },
    instrs: [
      { k: "within", path: "/Items/*", block: [], c: C },
      { k: "set", path: "/A/S", value: "", ifAbsent: false, c: C },
    ],
    input: "<Doc><Items><S/></Items></Doc>",
    expect: { output: "<Doc><Items><S/></Items><A><S/></A></Doc>" },
  },
  {
    name: "a place no instruction reads is moved whole, whatever it holds",
    why: "A field whose contract says nothing of what it holds is moved as it came, text, elements and attributes alike, under its new name.",
    xml: both(object({ Detail: { type: "any" } }), object({ Details: { type: "any" } })),
    instrs: [{ k: "move", from: "/Detail", to: "/Details", c: C }],
    input: '<Error><Code>X</Code><Detail lang="en">see <b>this</b></Detail></Error>',
    expect: {
      output: '<Error><Code>X</Code><Details lang="en">see <b>this</b></Details></Error>',
    },
  },
  {
    name: "an attribute the old contract does not have is taken off the start tag",
    why: "Removing a field written as an attribute removes the attribute and leaves the element's other attributes as they came.",
    xml: both(object({ staging: { type: "boolean", attribute: true } })),
    instrs: [{ k: "del", path: "/staging", c: C }],
    input: "<Distribution id='E1' staging=\"true\" kind='web'><Id>E1</Id></Distribution>",
    expect: { output: "<Distribution id='E1' kind='web'><Id>E1</Id></Distribution>" },
  },
  {
    name: "an attribute a program writes is escaped",
    why: "Quotes, markup characters and line breaks in an attribute's value must stay its value, and a line break must survive being read again.",
    xml: both(object({ note: { type: "string", attribute: true } })),
    instrs: [
      { k: "set", path: "/note", value: 'a "b" <c> & d\ne', ifAbsent: true, c: C },
    ],
    input: "<Item/>",
    expect: { output: '<Item note="a &quot;b&quot; &lt;c> &amp; d&#10;e"/>' },
  },
  {
    name: "a wrapped list that held nothing gains its items inside its wrapper",
    why: "The wrapper stays where it was and keeps its layout; the items go before the indent of its end tag.",
    xml: both(
      object({
        Fields: {
          type: "array",
          wrapped: true,
          items: { type: "string", name: "Field" },
        },
      }),
    ),
    instrs: [{ k: "set", path: "/Fields", value: ["id"], ifAbsent: false, c: C }],
    input: "<Q><Fields>\n</Fields></Q>",
    expect: { output: "<Q><Fields><Field>id</Field>\n</Fields></Q>" },
  },
  {
    name: "a list written in place becomes a wrapped one under a new name",
    why: "A contract that started wrapping a list writes the wrapper its description names around the items.",
    xml: both(
      object({ Tag: { type: "array", items: { type: "string", name: "Tag" } } }),
      object({
        Tags: { type: "array", wrapped: true, items: { type: "string", name: "Tag" } },
      }),
    ),
    instrs: [{ k: "move", from: "/Tag", to: "/Tags", c: C }],
    input: "<Post><Tag>a</Tag><Title>t</Title><Tag>b</Tag></Post>",
    expect: {
      output: "<Post><Title>t</Title><Tags><Tag>a</Tag><Tag>b</Tag></Tags></Post>",
    },
  },
  {
    name: "a renamed wrapped list keeps its layout, its items renamed with it",
    why: "The wrapper and each item are written under the names the new description gives them, and everything between them stays.",
    xml: both(
      object({
        Items: { type: "array", wrapped: true, items: { type: "string", name: "Item" } },
      }),
      object({
        Entries: {
          type: "array",
          wrapped: true,
          items: { type: "string", name: "Entry" },
        },
      }),
    ),
    instrs: [{ k: "move", from: "/Items", to: "/Entries", c: C }],
    input: "<R><Items>\n  <Item>a</Item>\n  <!-- b -->\n</Items></R>",
    expect: { output: "<R><Entries>\n  <Entry>a</Entry>\n  <!-- b -->\n</Entries></R>" },
  },
  {
    name: "a number is written back with the digits it has",
    why: "Scaling down writes the exact decimal, never a rounded double.",
    xml: both(object({ Amount: { type: "integer" } })),
    instrs: [{ k: "scale", path: "/Amount", exp: -2, c: C }],
    input: "<Charge><Amount>4999</Amount></Charge>",
    expect: { output: "<Charge><Amount>49.99</Amount></Charge>" },
  },
  {
    name: "a document type declaration is refused",
    why: "Entities are how XML bombs and external fetches get in; with no declaration there are none, so one is refused outright.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: '<?xml version="1.0"?><!DOCTYPE R [<!ENTITY x "a">]><R><S>&x;</S></R>',
    expect: { refuses: "body" },
  },
  {
    name: "an external entity is refused",
    why: "A document that names a file or a URL to read in must never make the runtime read it.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: '<!DOCTYPE R SYSTEM "file:///etc/passwd"><R><S>a</S></R>',
    expect: { refuses: "body" },
  },
  {
    name: "a reference to an entity XML does not define is refused",
    why: "Without a declaration, `&nbsp;` names nothing, and guessing what it meant is not reading XML.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "<R><S>a&nbsp;</S></R>",
    expect: { refuses: "body" },
  },
  {
    name: "text among an object's elements is refused",
    why: "Mixed content has no place in a tree of fields, and dropping it would lose it.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "<R>hello<S>a</S></R>",
    expect: { refuses: "body" },
  },
  {
    name: "attributes on a value the contract describes as text are refused",
    why: "A value is written back as text, and attributes nothing describes would be lost on the way.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: '<R><S unit="x">a</S></R>',
    expect: { refuses: "body" },
  },
  {
    name: "an encoding other than UTF-8 is refused",
    why: "The body was read as UTF-8, so one that says otherwise was not read as it was written.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: '<?xml version="1.0" encoding="ISO-8859-1"?><R><S>a</S></R>',
    expect: { refuses: "body" },
  },
  {
    name: "an attribute written twice is refused",
    why: "Well-formed XML names each attribute once, and which one to believe is a guess.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: '<R a="1" a="2"><S>a</S></R>',
    expect: { refuses: "body" },
  },
  {
    name: "a prefix nothing declares is refused",
    why: "An element's namespace is part of its name, and an undeclared prefix leaves it unknown.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "<R><p:S>a</p:S></R>",
    expect: { refuses: "body" },
  },
  {
    name: "an end tag that does not match is refused",
    why: "A document that is not well-formed is not XML.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "<R><S>a</T></R>",
    expect: { refuses: "body" },
  },
  {
    name: "content after the root element is refused",
    why: "A document has one root; a second is a second document.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "<R><S>a</S></R><R/>",
    expect: { refuses: "body" },
  },
  {
    name: "a field written twice where the contract has one is refused",
    why: "Which of the two an instruction should read is a guess.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "<R><S>a</S><S>a</S></R>",
    expect: { refuses: "body" },
  },
  {
    name: "a character XML does not allow is refused",
    why: "A control character cannot appear in XML, even written as a reference.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: "<R><S>a&#1;</S></R>",
    expect: { refuses: "body" },
  },
  {
    name: "a body nested past the limit is refused as too large",
    why: "Every step follows the nesting, and a body of a hundred thousand open tags must not exhaust the stack.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: `${"<a>".repeat(300)}${"</a>".repeat(300)}`,
    expect: { refuses: "too-large" },
  },
  {
    name: "a document of more namespace declarations than any real one is refused",
    why: "Each element that declares a namespace copies the ones in scope, so thousands of declarations under deep nesting would cost their product.",
    xml: both(object({ S: text })),
    instrs: [{ k: "enum", path: "/S", map: { a: "b" }, c: C }],
    input: `<R${Array.from({ length: 1025 }, (_, index) => ` xmlns:p${index}="urn:${index}"`).join("")}><S>a</S></R>`,
    expect: { refuses: "body" },
  },
  {
    name: "a null is refused by the change that wrote it",
    why: "XML has no null, and writing nothing or an empty element would be a guess about what the caller means.",
    xml: both(object({ S: text })),
    instrs: [{ k: "set", path: "/S", value: null, ifAbsent: false, c: "chg_null" }],
    input: "<R><S>a</S></R>",
    expect: { refuses: "chg_null" },
  },
  {
    name: "a description of a list of lists is refused",
    why: "OpenAPI gives a list of lists no XML form, so there is nothing to read it as.",
    xml: both(
      object({
        M: {
          type: "array",
          items: { type: "array", name: "Row", items: { type: "string", name: "C" } },
        },
      }),
    ),
    instrs: [{ k: "del", path: "/M", c: C }],
    input: "<R/>",
    expect: { refuses: "decode" },
  },
  {
    name: "a description that writes two fields as one element is refused",
    why: "An element that could be either field is a guess about which.",
    xml: both(
      object({ a: { type: "string", name: "X" }, b: { type: "string", name: "X" } }),
    ),
    instrs: [{ k: "del", path: "/a", c: C }],
    input: "<R/>",
    expect: { refuses: "decode" },
  },
  {
    name: "a program that reads a map's values in an XML body is refused",
    why: "XML has no maps, and a map's wildcard would reach the elements nothing names.",
    xml: both(object({ S: text })),
    instrs: [{ k: "del", path: "/{}", c: C }],
    input: "<R/>",
    expect: { refuses: "decode" },
  },
];
