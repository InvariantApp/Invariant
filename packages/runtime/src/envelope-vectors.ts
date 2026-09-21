/**
 * The golden vectors for the request envelope: what a program over the whole
 * request means, stated as data so another engine can be held to it.
 *
 * Each case is a site's path template, its envelope program, a request as a
 * binding hands it over, and the request that has to come out, or the change
 * that has to refuse it. `decode` means the program itself must be refused
 * before any request is seen.
 */
import type { EnvelopeProgram } from "@invariant/ir";

export interface EnvelopeVector {
  name: string;
  why: string;
  /** The site's path template, as the contract writes it. */
  template: string;
  envelope: EnvelopeProgram;
  request: {
    path: string;
    search: string;
    headers: [string, string][];
    body?: string;
  };
  expect:
    | {
        request: {
          path: string;
          search: string;
          headers: [string, string][];
          body?: string;
        };
      }
    | { refuses: string };
}

const C = "chg_vector";

const query = (
  name: string,
  type: "string" | "integer" | "number" | "boolean" = "string",
) => ({ in: "query" as const, name, style: "form" as const, explode: true, type });

export const ENVELOPE_VECTORS: EnvelopeVector[] = [
  {
    name: "a query parameter is renamed",
    why: "The commonest parameter break, and the case every other one builds on.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@query/limit", to: "/@query/page_size", c: C }],
      params: { old: [query("limit", "integer")], new: [query("page_size", "integer")] },
      body: false,
    },
    request: { path: "/items", search: "limit=10&sort=asc", headers: [] },
    expect: { request: { path: "/items", search: "sort=asc&page_size=10", headers: [] } },
  },
  {
    name: "an untouched query parameter keeps its exact bytes and its place",
    why:
      "Re-encoding what no Change named would break a signature or a cache key " +
      "that depends on those bytes, for no reason at all.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@query/limit", to: "/@query/page_size", c: C }],
      params: { old: [query("limit", "integer")], new: [query("page_size", "integer")] },
      body: false,
    },
    request: { path: "/items", search: "q=a%20b+c&limit=5&x=%7E", headers: [] },
    expect: {
      request: { path: "/items", search: "q=a%20b+c&x=%7E&page_size=5", headers: [] },
    },
  },
  {
    name: "a parameter the caller did not send stays unsent",
    why: "An optional parameter must not appear because a Change named it.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@query/limit", to: "/@query/page_size", c: C }],
      params: { old: [query("limit", "integer")], new: [query("page_size", "integer")] },
      body: false,
    },
    request: { path: "/items", search: "sort=asc", headers: [] },
    expect: { request: { path: "/items", search: "sort=asc", headers: [] } },
  },
  {
    name: "a query number is scaled exactly",
    why: "Parameters are typed from their declaration, so a scale sees a number.",
    template: "/quotes",
    envelope: {
      instrs: [{ k: "scale", path: "/@query/amount", exp: 2, c: C }],
      params: { old: [query("amount", "number")], new: [query("amount", "integer")] },
      body: false,
    },
    request: { path: "/quotes", search: "amount=49.99", headers: [] },
    expect: { request: { path: "/quotes", search: "amount=4999", headers: [] } },
  },
  {
    name: "a query value that is not a number is refused by the scale that needs one",
    why: "Text a number was declared for is passed to the instruction as text, which refuses it.",
    template: "/quotes",
    envelope: {
      instrs: [{ k: "scale", path: "/@query/amount", exp: 2, c: C }],
      params: { old: [query("amount", "number")], new: [query("amount", "integer")] },
      body: false,
    },
    request: { path: "/quotes", search: "amount=abc", headers: [] },
    expect: { refuses: C },
  },
  {
    name: "a query value is mapped",
    why: "An enum rename on a parameter is the same instruction as on a field.",
    template: "/items",
    envelope: {
      instrs: [
        {
          k: "enum",
          path: "/@query/sort",
          map: { asc: "ascending", desc: "descending" },
          c: C,
        },
      ],
      params: { old: [query("sort")], new: [query("sort")] },
      body: false,
    },
    request: { path: "/items", search: "sort=asc", headers: [] },
    expect: { request: { path: "/items", search: "sort=ascending", headers: [] } },
  },
  {
    name: "a newly required query parameter is supplied",
    why: "A default an old caller never sent, added without overwriting one they did.",
    template: "/items",
    envelope: {
      instrs: [
        { k: "set", path: "/@query/cursor", value: "start", ifAbsent: true, c: C },
      ],
      params: { old: [], new: [query("cursor")] },
      body: false,
    },
    request: { path: "/items", search: "", headers: [] },
    expect: { request: { path: "/items", search: "cursor=start", headers: [] } },
  },
  {
    name: "a repeated query parameter becomes a comma-separated one",
    why: "The value is a list either way; only how the contract writes it changed.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@query/tag", to: "/@query/tags", c: C }],
      params: {
        old: [{ ...query("tag"), type: "array", items: "string" }],
        new: [{ ...query("tags"), explode: false, type: "array", items: "string" }],
      },
      body: false,
    },
    request: { path: "/items", search: "tag=a&tag=b%20c", headers: [] },
    expect: { request: { path: "/items", search: "tags=a,b%20c", headers: [] } },
  },
  {
    name: "a header is renamed whatever case the caller wrote it in",
    why: "Header names are case-insensitive, so matching one exactly would miss it.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@header/x-page-size", to: "/@header/x-limit", c: C }],
      params: {
        old: [
          {
            in: "header",
            name: "x-page-size",
            style: "simple",
            explode: false,
            type: "integer",
          },
        ],
        new: [
          {
            in: "header",
            name: "x-limit",
            style: "simple",
            explode: false,
            type: "integer",
          },
        ],
      },
      body: false,
    },
    request: {
      path: "/items",
      search: "",
      headers: [
        ["Accept", "application/json"],
        ["X-Page-Size", "10"],
      ],
    },
    expect: {
      request: {
        path: "/items",
        search: "",
        headers: [
          ["Accept", "application/json"],
          ["x-limit", "10"],
        ],
      },
    },
  },
  {
    name: "a query parameter moves into a header",
    why: "Moving between locations is one move in one tree.",
    template: "/items",
    envelope: {
      instrs: [
        { k: "move", from: "/@query/api_version", to: "/@header/api-version", c: C },
      ],
      params: {
        old: [query("api_version")],
        new: [
          {
            in: "header",
            name: "api-version",
            style: "simple",
            explode: false,
            type: "string",
          },
        ],
      },
      body: false,
    },
    request: { path: "/items", search: "api_version=2024-01-01", headers: [] },
    expect: {
      request: { path: "/items", search: "", headers: [["api-version", "2024-01-01"]] },
    },
  },
  {
    name: "a query parameter moves into the body",
    why:
      "A search that moves from the query string into a JSON body is a location " +
      "move like any other, and the body is read only because a program reaches it.",
    template: "/search",
    envelope: {
      instrs: [{ k: "move", from: "/@query/limit", to: "/@body/limit", c: C }],
      params: { old: [query("limit", "integer")], new: [] },
      body: true,
    },
    request: { path: "/search", search: "limit=10&q=x", headers: [], body: '{"q":"x"}' },
    expect: {
      request: {
        path: "/search",
        search: "q=x",
        headers: [],
        body: '{"q":"x","limit":10}',
      },
    },
  },
  {
    name: "a path parameter is mapped and written back into the path",
    why: "A path parameter can be converted in place; the template is unchanged.",
    template: "/v1/items/{kind}",
    envelope: {
      instrs: [{ k: "enum", path: "/@path/kind", map: { old: "a/b" }, c: C }],
      params: {
        old: [
          { in: "path", name: "kind", style: "simple", explode: false, type: "string" },
        ],
        new: [],
      },
      body: false,
    },
    request: { path: "/v1/items/old", search: "", headers: [] },
    expect: { request: { path: "/v1/items/a%2Fb", search: "", headers: [] } },
  },
  {
    name: "a path parameter can only be converted",
    why: "A template has the parameters it has, so moving one out is refused at load.",
    template: "/v1/items/{kind}",
    envelope: {
      instrs: [{ k: "move", from: "/@path/kind", to: "/@query/kind", c: C }],
      params: {
        old: [
          { in: "path", name: "kind", style: "simple", explode: false, type: "string" },
        ],
        new: [query("kind")],
      },
      body: false,
    },
    request: { path: "/v1/items/old", search: "", headers: [] },
    expect: { refuses: "decode" },
  },
  {
    name: "a cookie is renamed and the others are kept",
    why: "Cookies are addressed one by one; the rest of the header is not the program's.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@cookie/theme", to: "/@cookie/ui_theme", c: C }],
      params: {
        old: [
          { in: "cookie", name: "theme", style: "form", explode: true, type: "string" },
        ],
        new: [
          {
            in: "cookie",
            name: "ui_theme",
            style: "form",
            explode: true,
            type: "string",
          },
        ],
      },
      body: false,
    },
    request: { path: "/items", search: "", headers: [["Cookie", "sid=abc; theme=dark"]] },
    expect: {
      request: {
        path: "/items",
        search: "",
        headers: [["cookie", "sid=abc; ui_theme=dark"]],
      },
    },
  },
  {
    name: "a deepObject is renamed, and a prototype key in it is dropped",
    why:
      "Property names in a deepObject are the caller's to choose, `__proto__` " +
      "included, and it must never become a key of anything.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@query/filter", to: "/@query/where", c: C }],
      params: {
        old: [
          {
            in: "query",
            name: "filter",
            style: "deepObject",
            explode: true,
            type: "object",
          },
        ],
        new: [
          {
            in: "query",
            name: "where",
            style: "deepObject",
            explode: true,
            type: "object",
          },
        ],
      },
      body: false,
    },
    request: {
      path: "/items",
      search: "filter%5Bstatus%5D=open&filter[__proto__]=1&page=2",
      headers: [],
    },
    expect: {
      request: { path: "/items", search: "page=2&where[status]=open", headers: [] },
    },
  },
  {
    name: "a header value that would break the line is refused",
    why: "A line break in a header value is how a request is smuggled.",
    template: "/items",
    envelope: {
      instrs: [{ k: "move", from: "/@query/note", to: "/@header/x-note", c: C }],
      params: {
        old: [query("note")],
        new: [
          {
            in: "header",
            name: "x-note",
            style: "simple",
            explode: false,
            type: "string",
          },
        ],
      },
      body: false,
    },
    request: { path: "/items", search: "note=a%0D%0AHost:%20evil", headers: [] },
    expect: { refuses: C },
  },
  {
    name: "a program touching a credential header is refused",
    why: "A program that can move a credential can move it somewhere it is logged.",
    template: "/items",
    envelope: {
      instrs: [
        { k: "move", from: "/@header/authorization", to: "/@header/x-auth", c: C },
      ],
      params: {
        old: [
          {
            in: "header",
            name: "authorization",
            style: "simple",
            explode: false,
            type: "string",
          },
        ],
        new: [
          {
            in: "header",
            name: "x-auth",
            style: "simple",
            explode: false,
            type: "string",
          },
        ],
      },
      body: false,
    },
    request: { path: "/items", search: "", headers: [["Authorization", "Bearer t"]] },
    expect: { refuses: "decode" },
  },
  {
    name: "a program naming a parameter it does not declare is refused",
    why: "Every parameter a program rewrites has to say how it is written.",
    template: "/items",
    envelope: {
      instrs: [{ k: "del", path: "/@query/debug", c: C }],
      params: { old: [], new: [] },
      body: false,
    },
    request: { path: "/items", search: "debug=1", headers: [] },
    expect: { refuses: "decode" },
  },
  {
    name: "a program addressing every query parameter at once is refused",
    why: "A wildcard over the query string would rewrite parameters nobody declared.",
    template: "/items",
    envelope: {
      instrs: [{ k: "del", path: "/@query/*", c: C }],
      params: { old: [query("a")], new: [] },
      body: false,
    },
    request: { path: "/items", search: "a=1", headers: [] },
    expect: { refuses: "decode" },
  },
];
