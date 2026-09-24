/**
 * XML bodies, as a tree and back.
 *
 * Amazon's CloudFront and CloudSearch, and every SOAP-era API described in
 * OpenAPI, send and take `text/xml`. A program describes fields, not
 * encodings, so the same instructions run whether a body arrived as JSON, as
 * a form or as XML: the XML is decoded into a tree, the instructions run, and
 * the tree is written back.
 *
 * Only the places the program names are decoded, as the site's description
 * says they are written: element or attribute, list wrapped or not, what each
 * holds. Every element on the way that the description does not name is kept
 * whole, bytes and all, and written back where it was, so a document the
 * instructions leave as it was comes out byte for byte as it went in, and one
 * they change differs only where they changed it.
 *
 * The parser is written for hostile input. A document type declaration is
 * refused outright, so there are no entities beyond XML's five and character
 * references, nothing external is ever fetched and nothing expands; nesting is
 * capped as a JSON body's is, and the whole body is capped before it is read.
 * Anything this cannot write back exactly, text mixed in among elements,
 * attributes on a value the contract describes as text, an encoding other than
 * UTF-8, is refused rather than guessed at.
 */

import { BodyTooDeepError } from "./errors.ts";
import { type CompiledInstr, TransformError, touchedPaths } from "./interpreter.ts";
import {
  isNumberLike,
  type Json,
  MAX_DEPTH,
  type NumberFidelity,
  numberTextOf,
  parseJson,
} from "./json.ts";

/**
 * How one place in an XML body is written, as a program's site describes it:
 * an element named `name`, or the field's own name, or with `attribute` an
 * attribute of its parent; a list's items repeated in place, or `wrapped`
 * in an element of the list's own; and what the place holds.
 */
export interface XmlNode {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean" | "any";
  name?: string;
  namespace?: string;
  prefix?: string;
  attribute?: true;
  wrapped?: true;
  properties?: Record<string, XmlNode>;
  items?: XmlNode;
}

/** A body read as `read` describes it, with the places written as `write` does. */
export interface XmlBody {
  read: XmlNode;
  write: XmlNode;
}

/** A body that is not XML this runtime will read, or will not write back. */
export class XmlBodyError extends SyntaxError {
  constructor(message: string) {
    super(`The body is not XML this operation can translate: ${message}`);
    this.name = "XmlBodyError";
  }
}

const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

/** Prefix to namespace, `""` for the default one. */
export type Scope = ReadonlyMap<string, string>;

const ROOT_SCOPE: Scope = new Map([["xml", XML_NAMESPACE]]);

export interface XmlAttribute {
  /** Where it is written, from the space before it to its closing quote. */
  from: number;
  to: number;
  qname: string;
  prefix: string;
  local: string;
  /** Its namespace: none for an attribute without a prefix. */
  namespace: string;
  /** Its value, references resolved and whitespace normalised as XML reads it. */
  value: string;
  /** True for a namespace declaration, `xmlns` or `xmlns:p`. */
  declares: boolean;
}

export interface XmlElement {
  kind: "element";
  /** The whole element, start tag to end tag. */
  from: number;
  to: number;
  /** Just past the `>` of the start tag, or of `/>`. */
  startTo: number;
  /** Where the end tag begins; `to` for an element written `<a/>`. */
  endFrom: number;
  empty: boolean;
  qname: string;
  prefix: string;
  local: string;
  namespace: string;
  attributes: XmlAttribute[];
  children: XmlChild[];
  /** The namespaces in scope where the element stands, before its own declarations. */
  inherited: Scope;
  /** With its own declarations. */
  scope: Scope;
}

export type XmlChild =
  | XmlElement
  | { kind: "text"; from: number; to: number; value: string; blank: boolean }
  | { kind: "other"; from: number; to: number };

export interface XmlDocument {
  text: string;
  root: XmlElement;
}

// ---------------------------------------------------------------------------
// Characters and names, as XML 1.0 (fifth edition) defines them.

function isChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function isNameStart(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x5f ||
    code === 0x3a ||
    (code >= 0xc0 && code <= 0xd6) ||
    (code >= 0xd8 && code <= 0xf6) ||
    (code >= 0xf8 && code <= 0x2ff) ||
    (code >= 0x370 && code <= 0x37d) ||
    (code >= 0x37f && code <= 0x1fff) ||
    (code >= 0x200c && code <= 0x200d) ||
    (code >= 0x2070 && code <= 0x218f) ||
    (code >= 0x2c00 && code <= 0x2fef) ||
    (code >= 0x3001 && code <= 0xd7ff) ||
    (code >= 0xf900 && code <= 0xfdcf) ||
    (code >= 0xfdf0 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0xeffff)
  );
}

function isNameChar(code: number): boolean {
  return (
    isNameStart(code) ||
    code === 0x2d ||
    code === 0x2e ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0xb7 ||
    (code >= 0x300 && code <= 0x36f) ||
    (code >= 0x203f && code <= 0x2040)
  );
}

const isSpace = (code: number) =>
  code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;

/** Whether text is a name with no colon in it, as an element or attribute's local part is. */
export function isNcName(text: string): boolean {
  if (text === "") return false;
  let first = true;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code === 0x3a || !(first ? isNameStart(code) : isNameChar(code))) return false;
    first = false;
  }
  return true;
}

/** Every character is one XML allows, so an unpaired surrogate or a control character is not. */
function checkChars(text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      throw new XmlBodyError(`an unpaired surrogate at offset ${index}`);
    }
    if (!isChar(code)) {
      throw new XmlBodyError(
        `the character U+${code.toString(16).toUpperCase().padStart(4, "0")} at offset ${index}, which XML does not allow`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing.

/**
 * The XML declaration this reads: version 1.0, and any encoding it names is
 * checked after. Written without back references so the Go engine holds its
 * declarations to the very same pattern.
 */
const DECLARATION =
  /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/;

const NAMED_REFERENCES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  apos: "'",
  quot: '"',
};

/**
 * How many namespace declarations one document may make. Each element that
 * declares one copies the namespaces in scope, so a document of thousands of
 * declarations under hundreds of nested elements would cost their product.
 * Real documents make a handful.
 */
const MAX_DECLARATIONS = 1024;

class Parser {
  readonly text: string;
  at = 0;
  declarations = 0;

  constructor(text: string) {
    this.text = text;
  }

  fail(message: string): never {
    throw new XmlBodyError(`${message} at offset ${this.at}`);
  }

  startsWith(literal: string): boolean {
    return this.text.startsWith(literal, this.at);
  }

  code(): number {
    return this.text.codePointAt(this.at) ?? -1;
  }

  spaces(): void {
    while (this.at < this.text.length && isSpace(this.text.charCodeAt(this.at))) {
      this.at += 1;
    }
  }

  name(): string {
    const start = this.at;
    const first = this.code();
    if (first === -1 || !isNameStart(first)) this.fail("expected a name");
    this.at += first > 0xffff ? 2 : 1;
    for (;;) {
      const code = this.code();
      if (code === -1 || !isNameChar(code)) break;
      this.at += code > 0xffff ? 2 : 1;
    }
    return this.text.slice(start, this.at);
  }

  /** A `&...;` reference at the cursor, resolved. */
  reference(): string {
    const end = this.text.indexOf(";", this.at);
    if (end === -1 || end - this.at > 16) this.fail("an unterminated reference");
    const body = this.text.slice(this.at + 1, end);
    let resolved: string | undefined;
    if (body.startsWith("#x")) {
      if (/^#x[0-9A-Fa-f]{1,6}$/.test(body))
        resolved = this.charRef(parseInt(body.slice(2), 16));
    } else if (body.startsWith("#")) {
      if (/^#[0-9]{1,7}$/.test(body))
        resolved = this.charRef(parseInt(body.slice(1), 10));
    } else if (Object.hasOwn(NAMED_REFERENCES, body)) {
      resolved = NAMED_REFERENCES[body];
    }
    if (resolved === undefined) {
      // Any other entity would need a document type declaration, which is
      // refused, so it is undeclared.
      this.fail(`the reference &${body}; which XML does not define`);
    }
    this.at = end + 1;
    return resolved;
  }

  charRef(code: number): string {
    if (!isChar(code)) this.fail(`a reference to a character XML does not allow`);
    return String.fromCodePoint(code);
  }

  /** Character data up to the next `<`, references resolved and line ends read as XML reads them. */
  charData(): { value: string; blank: boolean } {
    let value = "";
    let blank = true;
    while (this.at < this.text.length) {
      const code = this.text.charCodeAt(this.at);
      if (code === 0x3c) break;
      if (code === 0x26) {
        value += this.reference();
        blank = false;
        continue;
      }
      if (code === 0x5d && this.startsWith("]]>")) this.fail("`]]>` in text");
      if (code === 0x0d) {
        value += "\n";
        this.at += this.text.charCodeAt(this.at + 1) === 0x0a ? 2 : 1;
        continue;
      }
      if (!isSpace(code)) blank = false;
      value += this.text[this.at];
      this.at += 1;
    }
    return { value, blank };
  }

  /** An attribute's quoted value, normalised as XML reads it. */
  attributeValue(): string {
    const quote = this.text[this.at];
    if (quote !== '"' && quote !== "'") this.fail("expected a quoted value");
    this.at += 1;
    let value = "";
    for (;;) {
      if (this.at >= this.text.length) this.fail("an unterminated attribute value");
      const char = this.text[this.at] as string;
      if (char === quote) {
        this.at += 1;
        return value;
      }
      if (char === "<") this.fail("`<` in an attribute value");
      if (char === "&") {
        value += this.reference();
        continue;
      }
      if (char === "\r") {
        value += " ";
        this.at += this.text[this.at + 1] === "\n" ? 2 : 1;
        continue;
      }
      value += char === "\n" || char === "\t" ? " " : char;
      this.at += 1;
    }
  }

  comment(): void {
    const end = this.text.indexOf("--", this.at + 4);
    if (end === -1) this.fail("an unterminated comment");
    if (this.text[end + 2] !== ">") this.fail("`--` inside a comment");
    this.at = end + 3;
  }

  instruction(): void {
    this.at += 2;
    const target = this.name();
    if (target.toLowerCase() === "xml")
      this.fail("an XML declaration that is not at the start");
    const end = this.text.indexOf("?>", this.at);
    if (end === -1) this.fail("an unterminated processing instruction");
    if (end > this.at && !isSpace(this.text.charCodeAt(this.at))) {
      this.fail("a processing instruction with no space after its target");
    }
    this.at = end + 2;
  }

  /** Comments, processing instructions and white space, before or after the root. */
  misc(): void {
    for (;;) {
      this.spaces();
      if (this.startsWith("<!--")) this.comment();
      else if (this.startsWith("<?")) this.instruction();
      else return;
    }
  }
}

function splitName(parser: Parser, qname: string): { prefix: string; local: string } {
  const colon = qname.indexOf(":");
  if (colon === -1) return { prefix: "", local: qname };
  const prefix = qname.slice(0, colon);
  const local = qname.slice(colon + 1);
  if (prefix === "" || local === "" || local.includes(":")) {
    parser.fail(`the name ${qname}, which namespaces do not allow`);
  }
  return { prefix, local };
}

/**
 * The document, refused unless it is well-formed XML 1.0 with namespaces, in
 * UTF-8, with no document type declaration.
 */
export function parseXml(text: string): XmlDocument {
  checkChars(text);
  const parser = new Parser(text);
  if (text.charCodeAt(0) === 0xfeff) parser.at = 1;
  if (
    parser.startsWith("<?xml") &&
    /^[ \t\r\n?]/.test(text.slice(parser.at + 5, parser.at + 6))
  ) {
    const match = DECLARATION.exec(text.slice(parser.at));
    if (match === null)
      return parser.fail("an XML declaration this runtime does not read");
    const encoding = match[1] ?? match[2];
    if (encoding !== undefined && encoding.toLowerCase() !== "utf-8") {
      parser.fail(`the encoding ${encoding}; only UTF-8 is read`);
    }
    parser.at += match[0].length;
  }
  parser.misc();
  if (parser.startsWith("<!DOCTYPE"))
    parser.fail("a document type declaration, which is refused");
  if (parser.startsWith("<!")) parser.fail("a declaration before the root element");
  if (!parser.startsWith("<")) parser.fail("expected the root element");

  const root = startTag(parser, undefined);
  const open: XmlElement[] = root.empty ? [] : [root];
  while (open.length > 0) {
    const parent = open.at(-1) as XmlElement;
    if (!parser.startsWith("<")) {
      const from = parser.at;
      const { value, blank } = parser.charData();
      if (parser.at >= text.length) parser.fail("an element that is never closed");
      parent.children.push({ kind: "text", from, to: parser.at, value, blank });
    } else if (parser.startsWith("</")) {
      parent.endFrom = parser.at;
      parser.at += 2;
      const qname = parser.name();
      if (qname !== parent.qname) {
        parser.fail(`the end tag </${qname}> where </${parent.qname}> was open`);
      }
      parser.spaces();
      if (!parser.startsWith(">")) parser.fail("an unterminated end tag");
      parser.at += 1;
      parent.to = parser.at;
      open.pop();
    } else if (parser.startsWith("<!--")) {
      const from = parser.at;
      parser.comment();
      parent.children.push({ kind: "other", from, to: parser.at });
    } else if (parser.startsWith("<![CDATA[")) {
      const from = parser.at;
      const end = text.indexOf("]]>", from + 9);
      if (end === -1) parser.fail("an unterminated CDATA section");
      const value = text.slice(from + 9, end).replace(/\r\n?/g, "\n");
      parser.at = end + 3;
      parent.children.push({
        kind: "text",
        from,
        to: parser.at,
        value,
        blank: !/[^ \t\r\n]/.test(value),
      });
    } else if (parser.startsWith("<?")) {
      const from = parser.at;
      parser.instruction();
      parent.children.push({ kind: "other", from, to: parser.at });
    } else if (parser.startsWith("<!")) {
      parser.fail("a declaration inside the document");
    } else {
      if (open.length >= MAX_DEPTH) throw new BodyTooDeepError(MAX_DEPTH);
      const element = startTag(parser, parent);
      parent.children.push(element);
      if (!element.empty) open.push(element);
    }
  }
  parser.misc();
  if (parser.at < text.length) parser.fail("content after the root element");
  return { text, root };
}

/** A start tag at the cursor, its namespaces resolved against its parent's. */
function startTag(parser: Parser, parent: XmlElement | undefined): XmlElement {
  const from = parser.at;
  parser.at += 1;
  const qname = parser.name();
  const { prefix, local } = splitName(parser, qname);
  const attributes: XmlAttribute[] = [];
  for (;;) {
    const before = parser.at;
    parser.spaces();
    if (parser.startsWith("/>") || parser.startsWith(">")) break;
    if (parser.at >= parser.text.length) parser.fail("an unterminated start tag");
    if (parser.at === before) parser.fail("expected a space before an attribute");
    const name = parser.name();
    parser.spaces();
    if (!parser.startsWith("=")) parser.fail("expected `=` after an attribute's name");
    parser.at += 1;
    parser.spaces();
    const value = parser.attributeValue();
    const parts = splitName(parser, name);
    attributes.push({
      from: before,
      to: parser.at,
      qname: name,
      prefix: parts.prefix,
      local: parts.local,
      namespace: "",
      value,
      declares: name === "xmlns" || parts.prefix === "xmlns",
    });
  }
  const empty = parser.startsWith("/>");
  parser.at += empty ? 2 : 1;

  const inherited = parent?.scope ?? ROOT_SCOPE;
  const scope = declare(parser, inherited, attributes);
  const namespace = resolve(parser, scope, prefix, true, qname);
  const seen = new Set<string>();
  for (const attribute of attributes) {
    if (seen.has(attribute.qname)) parser.fail(`the attribute ${attribute.qname} twice`);
    seen.add(attribute.qname);
    if (attribute.declares) {
      attribute.namespace = XMLNS_NAMESPACE;
      continue;
    }
    if (attribute.prefix === "") continue;
    attribute.namespace = resolve(
      parser,
      scope,
      attribute.prefix,
      false,
      attribute.qname,
    );
    const expanded = `{${attribute.namespace}}${attribute.local}`;
    if (seen.has(expanded)) parser.fail(`the attribute ${attribute.qname} twice`);
    seen.add(expanded);
  }
  return {
    kind: "element",
    from,
    to: parser.at,
    startTo: parser.at,
    endFrom: parser.at,
    empty,
    qname,
    prefix,
    local,
    namespace,
    attributes,
    children: [],
    inherited,
    scope,
  };
}

function declare(parser: Parser, inherited: Scope, attributes: XmlAttribute[]): Scope {
  let scope: Map<string, string> | undefined;
  for (const attribute of attributes) {
    if (!attribute.declares) continue;
    const prefix = attribute.qname === "xmlns" ? "" : attribute.local;
    const uri = attribute.value;
    if (prefix === "xmlns") parser.fail("a declaration of the prefix xmlns");
    if (prefix === "xml" && uri !== XML_NAMESPACE) {
      parser.fail("the prefix xml bound to another namespace");
    }
    if (prefix !== "xml" && uri === XML_NAMESPACE) {
      parser.fail("the XML namespace bound to another prefix");
    }
    if (uri === XMLNS_NAMESPACE) parser.fail("the xmlns namespace declared");
    if (prefix !== "" && uri === "") parser.fail(`the prefix ${prefix} declared empty`);
    parser.declarations += 1;
    if (parser.declarations > MAX_DECLARATIONS) {
      parser.fail(`more than ${MAX_DECLARATIONS} namespace declarations`);
    }
    scope ??= new Map(inherited);
    scope.set(prefix, uri);
  }
  return scope ?? inherited;
}

function resolve(
  parser: Parser,
  scope: Scope,
  prefix: string,
  element: boolean,
  qname: string,
): string {
  if (prefix === "") return element ? (scope.get("") ?? "") : "";
  if (prefix === "xmlns") parser.fail(`the name ${qname}, which is reserved`);
  const uri = scope.get(prefix);
  if (uri === undefined) parser.fail(`the prefix of ${qname}, which is not declared`);
  return uri;
}

// ---------------------------------------------------------------------------
// Reading a document into a tree.

/** Keys a document's elements that the description does not name are kept under. */
const KEPT = "\u0000";

/**
 * An element the description does not name, kept whole and written back as
 * it came: a function, so that to every step that walks the tree it is a leaf
 * that is no kind of JSON value, and no pointer can read into it or write
 * inside it, at no cost to the steps that walk JSON.
 */
type Kept = () => never;

/** What each kept element is, and where it was decoded from. */
const KEPT_ELEMENTS = new WeakMap<Kept, From>();

function keep(element: XmlElement, key: string, item: boolean): Kept {
  const token: Kept = Object.freeze(() => {
    throw new TypeError("a kept XML element is not called");
  });
  KEPT_ELEMENTS.set(token, { element, key, item });
  return token;
}

/** The element a kept value stands for, if it is one. */
function keptOf(value: unknown): From | undefined {
  return typeof value === "function" ? KEPT_ELEMENTS.get(value as Kept) : undefined;
}

interface Placed {
  key: string;
  /** Its position in a list whose items are written in place. */
  index?: number;
  /** A value's text as it was decoded, so one left alone is written back as it came. */
  value?: unknown;
}

/** Where an object in the tree came from: its element, and what each child element became. */
interface ObjectOrigin {
  element: XmlElement;
  /** The key it was decoded under, and whether as one item of the list there. */
  key: string;
  item: boolean;
  placed: Map<XmlElement, Placed>;
  /** Each key's attribute and the value it was decoded to. */
  attributes: Map<string, { attribute: XmlAttribute; value: unknown }>;
  /** How many items each list written in place held. */
  counts: Map<string, number>;
}

/** Where a wrapped list came from: its wrapper and what each item was decoded to. */
interface ListOrigin {
  wrapper: XmlElement;
  values: unknown[];
  /** The key it was decoded under. */
  key: string;
}

export interface OpenedXml {
  document: XmlDocument;
  tree: Record<string, Json>;
  objects: WeakMap<object, ObjectOrigin>;
  lists: WeakMap<object, ListOrigin>;
  /** The same, by wrapper, for a list an instruction rebuilt, as `drop` does. */
  wrappers: Map<XmlElement, ListOrigin>;
}

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function typed(text: string, type: XmlNode["type"], fidelity: NumberFidelity): unknown {
  if ((type === "integer" || type === "number") && JSON_NUMBER.test(text)) {
    return parseJson(text, fidelity);
  }
  if (type === "boolean" && (text === "true" || text === "false")) return text === "true";
  return text;
}

/** The name an element for `key` has under `node`, and whether it holds one item of a list. */
function elementName(key: string, node: XmlNode): string {
  if (node.type === "array" && node.wrapped !== true) {
    return node.items?.name ?? key;
  }
  return node.name ?? key;
}

function matches(
  element: { local: string; namespace: string },
  name: string,
  node: XmlNode,
): boolean {
  return (
    element.local === name &&
    (node.namespace === undefined || element.namespace === node.namespace)
  );
}

function attributeMatches(attribute: XmlAttribute, name: string, node: XmlNode): boolean {
  return (
    !attribute.declares &&
    attribute.local === name &&
    attribute.namespace === (node.namespace ?? "")
  );
}

class Reader {
  readonly objects = new WeakMap<object, ObjectOrigin>();
  readonly lists = new WeakMap<object, ListOrigin>();
  readonly wrappers = new Map<XmlElement, ListOrigin>();
  readonly fidelity: NumberFidelity;

  constructor(fidelity: NumberFidelity) {
    this.fidelity = fidelity;
  }

  object(
    element: XmlElement,
    node: XmlNode,
    at = "",
    item = false,
  ): Record<string, Json> {
    const out: Record<string, Json> = {};
    const origin: ObjectOrigin = {
      element,
      key: at,
      item,
      placed: new Map(),
      attributes: new Map(),
      counts: new Map(),
    };
    const properties = Object.entries(node.properties ?? {});
    for (const attribute of element.attributes) {
      for (const [key, property] of properties) {
        if (property.attribute !== true) continue;
        if (!attributeMatches(attribute, property.name ?? key, property)) continue;
        const value = typed(attribute.value, property.type, this.fidelity);
        out[key] = value;
        origin.attributes.set(key, { attribute, value });
        break;
      }
    }
    let kept = 0;
    for (const child of element.children) {
      if (child.kind === "other") continue;
      if (child.kind === "text") {
        if (!child.blank) {
          throw new XmlBodyError(
            `<${element.qname}> holds text among its elements, which a tree cannot carry`,
          );
        }
        continue;
      }
      const found = properties.find(
        ([key, property]) =>
          property.attribute !== true &&
          matches(child, elementName(key, property), property),
      );
      if (found === undefined) {
        const key = `${KEPT}${kept}`;
        kept += 1;
        out[key] = keep(child, key, false);
        origin.placed.set(child, { key });
        continue;
      }
      const [key, property] = found;
      if (property.type === "array" && property.wrapped !== true) {
        const items = property.items as XmlNode;
        let list = out[key] as unknown[] | undefined;
        if (list === undefined) {
          list = [];
          out[key] = list;
        }
        const value = this.value(child, items, key, true);
        const index = list.length;
        list.push(value);
        origin.placed.set(child, { key, index, value: scalarOf(value) });
        origin.counts.set(key, index + 1);
        continue;
      }
      if (Object.hasOwn(out, key)) {
        throw new XmlBodyError(
          `<${element.qname}> holds <${child.qname}> twice, where its contract has one`,
        );
      }
      const value =
        property.type === "array"
          ? this.wrapped(child, property, key)
          : this.value(child, property, key, false);
      out[key] = value as Json;
      origin.placed.set(child, { key, value: scalarOf(value) });
    }
    this.objects.set(out, origin);
    return out;
  }

  wrapped(wrapper: XmlElement, node: XmlNode, key: string): unknown[] {
    const items = node.items as XmlNode;
    const name = items.name as string;
    const list: unknown[] = [];
    const values: unknown[] = [];
    for (const child of wrapper.children) {
      if (child.kind === "other") continue;
      if (child.kind === "text") {
        if (!child.blank) {
          throw new XmlBodyError(`<${wrapper.qname}> holds text among its items`);
        }
        continue;
      }
      if (!matches(child, name, items)) {
        throw new XmlBodyError(
          `<${wrapper.qname}> holds <${child.qname}>, which is not one of its items`,
        );
      }
      const value = this.value(child, items, key, true);
      list.push(value);
      values.push(scalarOf(value));
    }
    const origin = { wrapper, values, key };
    this.lists.set(list, origin);
    this.wrappers.set(wrapper, origin);
    return list;
  }

  value(element: XmlElement, node: XmlNode, key: string, item: boolean): unknown {
    if (node.type === "object") return this.object(element, node, key, item);
    // What no instruction reads by value is moved or removed whole, as it came.
    if (node.type === "any") return keep(element, key, item);
    if (node.type === "array") {
      // Checked when the program is read; a list of lists has no XML form.
      throw new XmlBodyError(`<${element.qname}> is described as a list of lists`);
    }
    if (element.attributes.some((attribute) => !attribute.declares)) {
      throw new XmlBodyError(
        `<${element.qname}> carries attributes its contract does not describe`,
      );
    }
    let text = "";
    for (const child of element.children) {
      if (child.kind === "element") {
        throw new XmlBodyError(
          `<${element.qname}> holds elements where its contract has a value`,
        );
      }
      if (child.kind === "text") text += child.value;
    }
    return typed(text, node.type, this.fidelity);
  }
}

/** A decoded value's own text, kept for telling whether it was left alone. */
function scalarOf(value: unknown): unknown {
  return typeof value === "object" && value !== null && !JSON.isRawJSON(value)
    ? undefined
    : value;
}

/** Whether `value` is still what was decoded, so the element can go back as it came. */
function unchanged(value: unknown, decoded: unknown): boolean {
  if (decoded === undefined) return false;
  if (isNumberLike(value) && isNumberLike(decoded)) {
    return numberTextOf(value) === numberTextOf(decoded);
  }
  return value === decoded;
}

/** Whether a media type is XML: `application/xml`, `text/xml` or anything `+xml`. */
export function isXmlMediaType(contentType: string | null | undefined): boolean {
  if (!contentType) return false;
  const media = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return media === "application/xml" || media === "text/xml" || media.endsWith("+xml");
}

/**
 * The charset a content type declares, where it declares one that is not
 * UTF-8, which is the only one read.
 */
function foreignCharset(contentType: string | null | undefined): string | undefined {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? "");
  const charset = match?.[1];
  return charset === undefined || charset.toLowerCase() === "utf-8" ? undefined : charset;
}

/** The places the description names, decoded from the document into a tree. */
export function openXml(
  body: XmlBody,
  text: string,
  fidelity: NumberFidelity,
  contentType?: string | null,
): OpenedXml {
  const charset = foreignCharset(contentType);
  if (charset !== undefined) {
    throw new XmlBodyError(`it is declared as ${charset}; only UTF-8 is read`);
  }
  const document = parseXml(text);
  const reader = new Reader(fidelity);
  const tree = reader.object(document.root, body.read);
  return {
    document,
    tree,
    objects: reader.objects,
    lists: reader.lists,
    wrappers: reader.wrappers,
  };
}

// ---------------------------------------------------------------------------
// Writing the tree back.

function escapeText(text: string): string {
  return text.replace(/[&<>\r]/g, (char) =>
    char === "&" ? "&amp;" : char === "<" ? "&lt;" : char === ">" ? "&gt;" : "&#13;",
  );
}

function escapeAttribute(text: string): string {
  return text.replace(/[&<"\t\n\r]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case '"':
        return "&quot;";
      case "\t":
        return "&#9;";
      case "\n":
        return "&#10;";
      default:
        return "&#13;";
    }
  });
}

/** Two strings by code point, which is how the Go engine orders them too. */
function byCodePoint(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference =
      ((left[index] as string).codePointAt(0) as number) -
      ((right[index] as string).codePointAt(0) as number);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

/** Namespace declarations to write on an element, in order: prefix, then namespace. */
type Declarations = [string, string][];

function written(declarations: Declarations): string {
  return declarations
    .map(([prefix, uri]) =>
      prefix === ""
        ? ` xmlns="${escapeAttribute(uri)}"`
        : ` xmlns:${prefix}="${escapeAttribute(uri)}"`,
    )
    .join("");
}

function declaring(scope: Scope, declarations: Declarations): Scope {
  if (declarations.length === 0) return scope;
  const out = new Map(scope);
  for (const [prefix, uri] of declarations) out.set(prefix, uri);
  return out;
}

interface Target {
  local: string;
  prefix?: string | undefined;
  namespace?: string | undefined;
}

interface Naming {
  qname: string;
  declarations: Declarations;
}

/**
 * The element a value was decoded from, and the key it was decoded under: a
 * place the description does not name keeps the name it had, as long as it
 * is still under that key.
 */
interface From {
  element: XmlElement;
  key: string;
  item: boolean;
}

const isTree = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !JSON.isRawJSON(value);

class Writer {
  readonly opened: OpenedXml;
  readonly text: string;
  readonly instrs: readonly CompiledInstr[];
  readonly depth: number;
  /** The keys from the root to what is being written, for naming a refusal. */
  readonly path: string[] = [];

  constructor(opened: OpenedXml, instrs: readonly CompiledInstr[], depth: number) {
    this.opened = opened;
    this.text = opened.document.text;
    this.instrs = instrs;
    this.depth = depth;
  }

  refuse(message: string): never {
    throw new TransformError(writerOf(this.instrs, this.path, this.depth), message);
  }

  where(): string {
    return this.path.length === 0 ? "the body" : `/${this.path.join("/")}`;
  }

  raw(from: number, to: number): string {
    return this.text.slice(from, to);
  }

  /** Runs `write` with `key` on the path, so a refusal inside it names where. */
  at<T>(key: string, write: () => T): T {
    this.path.push(key);
    const out = write();
    this.path.pop();
    return out;
  }

  scalarText(value: unknown): string {
    let text: string;
    if (typeof value === "string") text = value;
    else if (typeof value === "boolean") text = String(value);
    else if (isNumberLike(value)) text = numberTextOf(value);
    else if (value === null) {
      this.refuse(`${this.where()} is null, which XML has no way to write`);
    } else this.refuse(`${this.where()} holds a value XML cannot write as text`);
    try {
      checkChars(text);
    } catch {
      this.refuse(`${this.where()} holds a character XML does not allow`);
    }
    return text;
  }

  /** How `target` is written in `scope`, with any declaration that takes. */
  naming(target: Target, scope: Scope, attribute: boolean): Naming {
    if (!isNcName(target.local)) {
      this.refuse(
        `${this.where()} would be written as ${target.local}, which is not a name`,
      );
    }
    const prefix = target.prefix;
    const namespace = target.namespace;
    if (prefix !== undefined) {
      if (!isNcName(prefix) || prefix === "xmlns") {
        this.refuse(
          `${this.where()} has the prefix ${prefix}, which is not one XML allows`,
        );
      }
      const bound = scope.get(prefix);
      if (namespace === undefined) {
        if (bound === undefined) {
          this.refuse(`${this.where()} has the prefix ${prefix}, which is not declared`);
        }
        return { qname: `${prefix}:${target.local}`, declarations: [] };
      }
      return {
        qname: `${prefix}:${target.local}`,
        declarations: bound === namespace ? [] : [[prefix, namespace]],
      };
    }
    if (namespace === undefined) return { qname: target.local, declarations: [] };
    if (attribute) {
      // An attribute without a prefix has no namespace, so it takes one bound here.
      const bound = [...scope]
        .filter(([key, uri]) => key !== "" && uri === namespace)
        .map(([key]) => key)
        .sort(byCodePoint)[0];
      if (bound === undefined) {
        this.refuse(`${this.where()} is in a namespace no prefix is declared for`);
      }
      return { qname: `${bound}:${target.local}`, declarations: [] };
    }
    return {
      qname: target.local,
      declarations: (scope.get("") ?? "") === namespace ? [] : [["", namespace]],
    };
  }

  /**
   * Declarations that give an element written under `scope` the namespaces it
   * had where it came from, so what it holds means what it meant; and the
   * scope inside it. Nothing, for an element that stayed where it was.
   */
  restoring(
    element: XmlElement,
    scope: Scope,
  ): { declarations: Declarations; scope: Scope } {
    const own = new Set(
      element.attributes
        .filter((attribute) => attribute.declares)
        .map((attribute) => (attribute.qname === "xmlns" ? "" : attribute.local)),
    );
    const declarations: Declarations = [];
    const prefixes = [...new Set([...element.inherited.keys(), ...scope.keys()])].sort(
      byCodePoint,
    );
    for (const prefix of prefixes) {
      if (own.has(prefix) || prefix === "xml") continue;
      const was = element.inherited.get(prefix);
      const now = scope.get(prefix);
      if (prefix === "") {
        if ((was ?? "") !== (now ?? "")) declarations.push(["", was ?? ""]);
      } else if (was !== undefined && was !== now) {
        // A prefix bound here and not where the element came from means
        // nothing to it, since nothing inside it could have used it.
        declarations.push([prefix, was]);
      }
    }
    const inner = new Map(declaring(scope, declarations));
    for (const attribute of element.attributes) {
      if (attribute.declares) {
        inner.set(attribute.qname === "xmlns" ? "" : attribute.local, attribute.value);
      }
    }
    return { declarations, scope: inner };
  }

  targetFor(key: string, node: XmlNode | undefined, item: boolean, from?: From): Target {
    const kept = from !== undefined && from.key === key && from.item === item;
    if (item) {
      const items = node?.type === "array" ? node.items : undefined;
      if (items === undefined && kept) {
        return { local: from.element.local, prefix: from.element.prefix || undefined };
      }
      return {
        local: items?.name ?? (node?.wrapped === true ? (node.name ?? key) : key),
        prefix: items?.prefix,
        namespace: items?.namespace,
      };
    }
    if (node === undefined && kept) {
      return { local: from.element.local, prefix: from.element.prefix || undefined };
    }
    return { local: node?.name ?? key, prefix: node?.prefix, namespace: node?.namespace };
  }

  /** Where an object was decoded from, if it was. */
  fromOf(value: object): From | undefined {
    const origin = this.opened.objects.get(value);
    return origin === undefined
      ? undefined
      : { element: origin.element, key: origin.key, item: origin.item };
  }

  /** Whether an element already stands for `target`, so it need not be renamed. */
  named(element: XmlElement, target: Target): boolean {
    return (
      element.local === target.local &&
      (target.prefix === undefined || element.prefix === target.prefix) &&
      (target.namespace === undefined || element.namespace === target.namespace)
    );
  }

  attribute(
    value: unknown,
    target: Target,
    scope: Scope,
  ): { text: string; naming: Naming } {
    const naming = this.naming(target, scope, true);
    return {
      text: ` ${naming.qname}="${escapeAttribute(this.scalarText(value))}"`,
      naming,
    };
  }

  /**
   * An object as an element. Where it was decoded from one, that element's
   * start tag, the children it held that nothing names and everything between
   * them are written as they came, and each field where it was.
   */
  object(
    value: Record<string, unknown>,
    target: Target,
    node: XmlNode | undefined,
    scope: Scope,
    root = false,
  ): string {
    const origin = this.opened.objects.get(value);
    if (origin === undefined) return this.fresh(value, target, node, scope);
    const element = origin.element;
    const properties = node?.properties ?? {};
    const isAttribute = (key: string) => properties[key]?.attribute === true;

    const renamed = !root && !this.named(element, target);
    const restored = root
      ? { declarations: [] as Declarations, scope: element.scope }
      : this.restoring(element, scope);
    const naming: Naming = renamed
      ? this.naming(target, restored.scope, false)
      : { qname: element.qname, declarations: [] };
    let inner = declaring(restored.scope, naming.declarations);

    // Attributes: each as it came, one decoded as it is now, then any new one.
    const heldBy = new Map<XmlAttribute, string>();
    for (const [key, held] of origin.attributes) heldBy.set(held.attribute, key);
    let attributes = "";
    let changed = false;
    const added: Declarations = [];
    for (const attribute of element.attributes) {
      const key = heldBy.get(attribute);
      if (key === undefined) {
        attributes += this.raw(attribute.from, attribute.to);
        continue;
      }
      if (!Object.hasOwn(value, key) || !isAttribute(key)) {
        changed = true;
        continue;
      }
      const now = value[key];
      if (unchanged(now, origin.attributes.get(key)?.value)) {
        attributes += this.raw(attribute.from, attribute.to);
        continue;
      }
      changed = true;
      attributes += this.at(
        key,
        () => ` ${attribute.qname}="${escapeAttribute(this.scalarText(now))}"`,
      );
    }
    for (const key of Object.keys(value)) {
      if (!isAttribute(key) || origin.attributes.has(key)) continue;
      changed = true;
      const made = this.at(key, () =>
        this.attribute(value[key], this.targetFor(key, properties[key], false), inner),
      );
      attributes += made.text;
      added.push(...made.naming.declarations);
      inner = declaring(inner, made.naming.declarations);
    }

    // Children, each where it was, then any new one before the end tag's indent.
    let content = "";
    const done = new Set<string>();
    for (const child of element.children) {
      if (child.kind !== "element") {
        content += this.raw(child.from, child.to);
        continue;
      }
      const placed = origin.placed.get(child) as Placed;
      const key = placed.key;
      if (!Object.hasOwn(value, key) || isAttribute(key)) continue;
      const now = value[key];
      const property = properties[key];
      const from: From = { element: child, key, item: placed.index !== undefined };
      content += this.at(key, () => {
        if (placed.index === undefined) {
          done.add(key);
          return this.field(key, now, property, inner, from, placed.value);
        }
        const wrapped = property?.type === "array" && property.wrapped === true;
        if (Array.isArray(now) && !wrapped) {
          // One item of a list written in place, where that item was; any the
          // list gained follow its last.
          done.add(key);
          let out = "";
          if (placed.index < now.length) {
            out += this.at(String(placed.index), () =>
              this.item(
                key,
                now[placed.index as number],
                property,
                inner,
                from,
                placed.value,
              ),
            );
          }
          if (placed.index === (origin.counts.get(key) ?? 0) - 1) {
            for (let index = placed.index + 1; index < now.length; index += 1) {
              out += this.at(String(index), () =>
                this.item(key, now[index], property, inner),
              );
            }
          }
          return out;
        }
        if (placed.index !== 0) return "";
        // The list became one value, or a list written some other way, which
        // stands where its first item did.
        done.add(key);
        return this.field(key, now, property, inner, from, placed.value);
      });
    }
    let fresh = "";
    for (const key of Object.keys(value)) {
      if (done.has(key) || isAttribute(key)) continue;
      fresh += this.at(key, () => this.field(key, value[key], properties[key], inner));
    }
    if (fresh !== "") {
      const tail = trailingSpace(element, this.text);
      content = content.slice(0, content.length - tail.length) + fresh + tail;
    }

    const declarations = [...restored.declarations, ...naming.declarations, ...added];
    const same = !renamed && !changed && declarations.length === 0;
    const head = `<${naming.qname}${attributes}${written(declarations)}`;
    if (element.empty && content === "") {
      return same ? this.raw(element.from, element.to) : `${head}/>`;
    }
    const start =
      same && !element.empty ? this.raw(element.from, element.startTo) : `${head}>`;
    const end =
      !renamed && !element.empty
        ? this.raw(element.endFrom, element.to)
        : `</${naming.qname}>`;
    return start + content + end;
  }

  /** An object no element was decoded to, as a new element: attributes first, then fields. */
  fresh(
    value: Record<string, unknown>,
    target: Target,
    node: XmlNode | undefined,
    scope: Scope,
  ): string {
    const naming = this.naming(target, scope, false);
    let inner = declaring(scope, naming.declarations);
    const declarations = [...naming.declarations];
    const properties = node?.properties ?? {};
    let attributes = "";
    for (const key of Object.keys(value)) {
      const property = properties[key];
      if (property?.attribute !== true) continue;
      const made = this.at(key, () =>
        this.attribute(value[key], this.targetFor(key, property, false), inner),
      );
      attributes += made.text;
      declarations.push(...made.naming.declarations);
      inner = declaring(inner, made.naming.declarations);
    }
    let content = "";
    for (const key of Object.keys(value)) {
      const property = properties[key];
      if (property?.attribute === true) continue;
      content += this.at(key, () => this.field(key, value[key], property, inner));
    }
    const head = `<${naming.qname}${attributes}${written(declarations)}`;
    return content === "" ? `${head}/>` : `${head}>${content}</${naming.qname}>`;
  }

  /** One field of an object, as the element or elements that write it. */
  field(
    key: string,
    value: unknown,
    node: XmlNode | undefined,
    scope: Scope,
    from?: From,
    decoded?: unknown,
  ): string {
    const held = keptOf(value);
    if (held) return this.kept(held, key, node, scope, false);
    if (Array.isArray(value)) {
      const list =
        this.opened.lists.get(value) ??
        (from === undefined || from.item
          ? undefined
          : this.opened.wrappers.get(from.element));
      const wrapped =
        node !== undefined && node.type === "array"
          ? node.wrapped === true
          : list !== undefined;
      if (wrapped) return this.wrapped(key, value, node, scope, list);
      let out = "";
      for (const [index, item] of value.entries()) {
        out += this.at(String(index), () => this.item(key, item, node, scope));
      }
      return out;
    }
    if (isTree(value)) {
      return this.object(
        value,
        this.targetFor(key, node, false, this.fromOf(value)),
        node,
        scope,
      );
    }
    return this.scalar(
      value,
      this.targetFor(key, node, false, from),
      scope,
      from,
      decoded,
    );
  }

  /** A list inside an element of its own: the wrapper it came in, where it came in one. */
  wrapped(
    key: string,
    value: unknown[],
    node: XmlNode | undefined,
    scope: Scope,
    list: ListOrigin | undefined,
  ): string {
    const target = this.targetFor(
      key,
      node,
      false,
      list === undefined
        ? undefined
        : { element: list.wrapper, key: list.key, item: false },
    );
    if (list === undefined) {
      const naming = this.naming(target, scope, false);
      const inner = declaring(scope, naming.declarations);
      let items = "";
      for (const [index, item] of value.entries()) {
        items += this.at(String(index), () => this.item(key, item, node, inner));
      }
      const head = `<${naming.qname}${written(naming.declarations)}`;
      return items === "" ? `${head}/>` : `${head}>${items}</${naming.qname}>`;
    }
    const wrapper = list.wrapper;
    const renamed = !this.named(wrapper, target);
    const restored = this.restoring(wrapper, scope);
    const naming: Naming = renamed
      ? this.naming(target, restored.scope, false)
      : { qname: wrapper.qname, declarations: [] };
    const inner = declaring(restored.scope, naming.declarations);
    let last = -1;
    for (const [at, child] of wrapper.children.entries()) {
      if (child.kind === "element") last = at;
    }
    let content = "";
    let index = 0;
    for (const [at, child] of wrapper.children.entries()) {
      if (child.kind !== "element") {
        content += this.raw(child.from, child.to);
        continue;
      }
      const position = index;
      if (position < value.length) {
        content += this.at(String(position), () =>
          this.item(
            key,
            value[position],
            node,
            inner,
            { element: child, key: list.key, item: true },
            list.values[position],
          ),
        );
      }
      index += 1;
      if (at === last) {
        for (let extra = index; extra < value.length; extra += 1) {
          content += this.at(String(extra), () =>
            this.item(key, value[extra], node, inner),
          );
        }
      }
    }
    if (last === -1 && value.length > 0) {
      let items = "";
      for (const [position, item] of value.entries()) {
        items += this.at(String(position), () => this.item(key, item, node, inner));
      }
      const tail = trailingSpace(wrapper, this.text);
      content = content.slice(0, content.length - tail.length) + items + tail;
    }
    const declarations = [...restored.declarations, ...naming.declarations];
    const same = !renamed && declarations.length === 0;
    const attributes = wrapper.attributes
      .map((attribute) => this.raw(attribute.from, attribute.to))
      .join("");
    const head = `<${naming.qname}${attributes}${written(declarations)}`;
    if (wrapper.empty && content === "") {
      return same ? this.raw(wrapper.from, wrapper.to) : `${head}/>`;
    }
    const start =
      same && !wrapper.empty ? this.raw(wrapper.from, wrapper.startTo) : `${head}>`;
    const end =
      !renamed && !wrapper.empty
        ? this.raw(wrapper.endFrom, wrapper.to)
        : `</${naming.qname}>`;
    return start + content + end;
  }

  /** One item of a list, named as the list's items are. */
  item(
    key: string,
    value: unknown,
    node: XmlNode | undefined,
    scope: Scope,
    from?: From,
    decoded?: unknown,
  ): string {
    const held = keptOf(value);
    if (held) return this.kept(held, key, node, scope, true);
    if (Array.isArray(value)) {
      this.refuse(`${this.where()} is a list inside a list, which XML cannot write`);
    }
    if (isTree(value)) {
      const items = node?.type === "array" ? node.items : undefined;
      return this.object(
        value,
        this.targetFor(key, node, true, this.fromOf(value)),
        items,
        scope,
      );
    }
    return this.scalar(
      value,
      this.targetFor(key, node, true, from),
      scope,
      from,
      decoded,
    );
  }

  /** An element nothing names: exactly as it came, unless it has to be renamed or moved. */
  kept(
    value: From,
    key: string,
    node: XmlNode | undefined,
    scope: Scope,
    item: boolean,
  ): string {
    const element = value.element;
    if (key.startsWith(KEPT)) return this.raw(element.from, element.to);
    const target = this.targetFor(key, node, item, value);
    const restored = this.restoring(element, scope);
    const renamed = !this.named(element, target);
    if (!renamed && restored.declarations.length === 0) {
      return this.raw(element.from, element.to);
    }
    const naming: Naming = renamed
      ? this.naming(target, restored.scope, false)
      : { qname: element.qname, declarations: [] };
    const attributes = element.attributes
      .map((attribute) => this.raw(attribute.from, attribute.to))
      .join("");
    const head = `<${naming.qname}${attributes}${written([...restored.declarations, ...naming.declarations])}`;
    if (element.empty) return `${head}/>`;
    return `${head}>${this.raw(element.startTo, element.endFrom)}</${naming.qname}>`;
  }

  /** A value as an element holding its text, in the element it came from where it can be. */
  scalar(
    value: unknown,
    target: Target,
    scope: Scope,
    from?: From,
    decoded?: unknown,
  ): string {
    const text = this.scalarText(value);
    const origin = from?.element;
    if (origin !== undefined && decoded !== undefined && this.named(origin, target)) {
      if (unchanged(value, decoded)) return this.raw(origin.from, origin.to);
      const start = origin.empty
        ? `${this.raw(origin.from, origin.startTo - 2)}>`
        : this.raw(origin.from, origin.startTo);
      const end = origin.empty
        ? `</${origin.qname}>`
        : this.raw(origin.endFrom, origin.to);
      return start + escapeText(text) + end;
    }
    const naming = this.naming(target, scope, false);
    const head = `<${naming.qname}${written(naming.declarations)}`;
    return text === "" ? `${head}/>` : `${head}>${escapeText(text)}</${naming.qname}>`;
  }
}

/** The white space that indents an element's end tag, where its content ends in some. */
function trailingSpace(element: XmlElement, text: string): string {
  const last = element.children.at(-1);
  if (last === undefined || last.kind !== "text" || !last.blank) return "";
  // A CDATA section is text too, but not indentation to keep apart.
  const raw = text.slice(last.from, last.to);
  return raw.startsWith("<") ? "" : raw;
}

/** The change that last wrote at or under the first key of `path`, for naming a refusal. */
function writerOf(
  instrs: readonly CompiledInstr[],
  path: readonly string[],
  depth: number,
): string {
  const first = path[0];
  for (let index = instrs.length - 1; index >= 0; index -= 1) {
    const instr = instrs[index] as CompiledInstr;
    if (first === undefined) return instr.c;
    if (touchedPaths(instr).some((touched) => touched[depth] === first)) return instr.c;
  }
  return instrs[0]?.c ?? "";
}

/**
 * The tree written back into the document it was read from. `depth` is how
 * many segments lead to the body in the instructions' paths: none for a
 * body's own list, one for `/@body` in a request's envelope.
 */
export function closeXml(
  opened: OpenedXml,
  write: XmlNode,
  instrs: readonly CompiledInstr[],
  depth: number,
): string {
  const writer = new Writer(opened, instrs, depth);
  const { document, tree } = opened;
  const root = document.root;
  const body = writer.object(tree, { local: root.local }, write, root.inherited, true);
  return writer.raw(0, root.from) + body + writer.raw(root.to, document.text.length);
}
