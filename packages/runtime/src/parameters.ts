/**
 * Parameters written and read the way the runtime writes and reads them.
 *
 * For whatever has to produce or check the traffic an old caller sends, such
 * as the verifier's laws, through the same encoder and decoder the envelope
 * uses rather than a second copy that could disagree with it.
 */
import {
  closeEnvelope,
  codecKey,
  type DecodedEnvelope,
  type EnvelopeRequest,
  openEnvelope,
  PART,
  type ParamCodec,
  type ParamLocation,
  templateNames,
} from "./envelope.ts";
import type { Json } from "./json.ts";
import { matchTemplate } from "./program.ts";

export type ParameterValues = Record<ParamLocation, Record<string, Json>>;

const emptyValues = (): ParameterValues => ({
  path: {},
  query: {},
  header: {},
  cookie: {},
});

function envelopeFor(codecs: readonly ParamCodec[]): DecodedEnvelope {
  const map = new Map(codecs.map((codec) => [codecKey(codec.in, codec.name), codec]));
  return { instrs: [], old: map, new: map, body: false };
}

/**
 * A request carrying these parameter values, written the way the codecs say.
 * Every parameter of the template needs a value. Used to generate traffic an
 * old caller could send, through the same encoder the runtime writes with.
 */
export function writeParameters(
  codecs: readonly ParamCodec[],
  template: string,
  values: Partial<ParameterValues>,
): EnvelopeRequest {
  const segments = template.split("/");
  const tree: Record<string, Json> = {};
  for (const location of ["path", "query", "header", "cookie"] as const) {
    tree[PART[location]] = { ...(values[location] ?? {}) };
  }
  const request = { path: template, search: "", headers: [], body: undefined };
  return closeEnvelope(
    envelopeFor(codecs),
    segments,
    templateNames(segments),
    request,
    tree,
  );
}

/** The values of these parameters as a request carries them, typed by the codecs. */
export function readParameters(
  codecs: readonly ParamCodec[],
  template: string,
  request: EnvelopeRequest,
): ParameterValues {
  const segments = template.split("/");
  const matched = matchTemplate(segments, request.path) ?? [];
  const tree = openEnvelope(envelopeFor(codecs), segments, matched, request, "double");
  const out = emptyValues();
  for (const location of ["path", "query", "header", "cookie"] as const) {
    out[location] = (tree[PART[location]] ?? {}) as Record<string, Json>;
  }
  return out;
}
