/**
 * Where an SDK declares something, and every place the consumer refers to it.
 *
 * This is the one part of the pack that asks a type checker anything, behind
 * an interface that says nothing about the Language Server Protocol, so
 * pyright can be swapped for another checker (pyrefly is the candidate)
 * without the engine noticing.
 *
 * A declaration is found the way a person would check one: by writing a line
 * of Python that reaches it from the type, `value.automatic_tax.liability`
 * with `value: stripe.Subscription`, and asking where the last name points.
 * That goes through the SDK's own annotations, `Optional`, nested classes and
 * lists alike, with nothing about any one SDK's layout written down here. The
 * line lives in a file that is opened in the checker and never written to
 * disk.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LineIndex } from "./offsets.ts";
import type { Diagnostic, Location, Position, Pyright } from "./pyright.ts";

/** A place in one of the consumer's sources, as offsets into its text. */
export interface Span {
  file: string;
  start: number;
  end: number;
}

/**
 * Where the SDK declares a name. Opaque to the engine: it is only handed back
 * to ask for references, and compared with where other names point.
 */
export interface Declaration {
  file: string;
  line: number;
  character: number;
}

export interface ReferenceProvider {
  /**
   * Where the SDK declares the member reached from `typeName` by `path`
   * (`*` for a list's items), or nothing where no such member resolves.
   */
  declarationOf(
    typeName: string,
    path: readonly string[],
  ): Promise<Declaration | undefined>;
  /** Where the SDK declares a module-level name, such as `stripe.api_version`. */
  moduleAttribute(module: string, name: string): Promise<Declaration | undefined>;
  /** Every reference in the consumer's sources to a declaration found above. */
  referencesTo(declaration: Declaration): Promise<Span[]>;
  /** Where the name at `offset` in a source file is declared, in a source or the SDK. */
  definitionAt(file: string, offset: number): Promise<(Span | Declaration)[]>;
  /** What the checker says the name at `offset` is, as hover text. */
  typeAt(file: string, offset: number): Promise<string | undefined>;
}

export interface Verifier {
  /** Errors in each file, against whatever packages the checker was started with. */
  errors(files: readonly string[]): Promise<Map<string, Diagnostic[]>>;
}

export function isSpan(place: Span | Declaration): place is Span {
  return "start" in place;
}

export const sameDeclaration = (a: Declaration, b: Declaration) =>
  a.file === b.file && a.line === b.line && a.character === b.character;

const PROBE = "__invariant_probe__.py";

/** pyright as a `ReferenceProvider` and a `Verifier`, over the files it has open. */
export class PyrightReferences implements ReferenceProvider, Verifier {
  private readonly server: Pyright;
  private readonly root: string;
  /** The text of every source, so a location in one converts to offsets. */
  private readonly texts: Map<string, string>;
  private readonly indexes = new Map<string, LineIndex>();
  /** Where each declaration was reached from, which is where its references are asked from. */
  private readonly reachedFrom = new Map<string, { text: string; position: Position }>();

  constructor(server: Pyright, root: string, texts: Map<string, string>) {
    this.server = server;
    this.root = root.replace(/\/+$/, "");
    this.texts = texts;
  }

  private indexOf(file: string): LineIndex {
    let index = this.indexes.get(file);
    if (!index) {
      index = new LineIndex(this.texts.get(file) ?? "");
      this.indexes.set(file, index);
    }
    return index;
  }

  private get probe(): string {
    return `${this.root}/${PROBE}`;
  }

  private placeOf(location: Location): Span | Declaration {
    const file = fileURLToPath(location.uri);
    if (
      !this.texts.has(file) &&
      file !== this.probe &&
      file.startsWith(`${this.root}/`)
    ) {
      // A file of the consumer's that no source imported by name, such as
      // the settings module a pin's value is assigned in: read it now, so
      // what is found there can be edited like anything else.
      try {
        this.texts.set(file, readFileSync(file, "utf8"));
      } catch {
        // Gone or unreadable: it is reported as a place outside the sources.
      }
    }
    if (!this.texts.has(file)) {
      return {
        file,
        line: location.range.start.line,
        character: location.range.start.character,
      };
    }
    const index = this.indexOf(file);
    return {
      file,
      start: index.offsetAt(location.range.start),
      end: index.offsetAt(location.range.end),
    };
  }

  private async probeAt(text: string, offset: number): Promise<Declaration | undefined> {
    await this.server.open(this.probe, text);
    const position = new LineIndex(text).positionAt(offset);
    const found = (await this.server.definition(this.probe, position))[0];
    if (!found) return undefined;
    const place = this.placeOf(found);
    // A name the SDK does not declare resolves to nothing, or back into the
    // probe or the consumer's own code; none of those is the SDK's.
    if (
      isSpan(place) ||
      place.file === this.probe ||
      place.file.startsWith(`${this.root}/`)
    ) {
      return undefined;
    }
    this.reachedFrom.set(keyOf(place), { text, position });
    return place;
  }

  async declarationOf(
    typeName: string,
    path: readonly string[],
  ): Promise<Declaration | undefined> {
    const leaf = path.at(-1);
    if (!leaf || !/^[A-Za-z_]\w*$/.test(leaf)) return undefined;
    const reach = path
      .map((segment) => (segment === "*" ? "[0]" : `.${segment}`))
      .join("");
    const module = typeName.split(".")[0] as string;
    const text = `import ${module}\n\n\ndef __invariant_probe(value: "${typeName}") -> None:\n    value${reach}\n`;
    return this.probeAt(text, text.lastIndexOf(`.${leaf}`) + 1);
  }

  async moduleAttribute(module: string, name: string): Promise<Declaration | undefined> {
    const text = `import ${module}\n\n${module}.${name}\n`;
    return this.probeAt(text, text.lastIndexOf(`.${name}`) + 1);
  }

  async referencesTo(declaration: Declaration): Promise<Span[]> {
    const from = this.reachedFrom.get(keyOf(declaration));
    if (!from) return [];
    // The probe is opened again with the text the declaration was reached
    // from, since a later probe replaced it.
    await this.server.open(this.probe, from.text);
    const locations = await this.server.references(this.probe, from.position);
    return locations
      .map((location) => this.placeOf(location))
      .filter((place): place is Span => isSpan(place) && place.file !== this.probe);
  }

  async definitionAt(file: string, offset: number): Promise<(Span | Declaration)[]> {
    const locations = await this.server.definition(
      file,
      this.indexOf(file).positionAt(offset),
    );
    return locations.map((location) => this.placeOf(location));
  }

  async typeAt(file: string, offset: number): Promise<string | undefined> {
    return this.server.hover(file, this.indexOf(file).positionAt(offset));
  }

  async errors(files: readonly string[]): Promise<Map<string, Diagnostic[]>> {
    const found = new Map<string, Diagnostic[]>();
    for (const file of files) {
      const diagnostics = await this.server.diagnosticsOf(file);
      found.set(
        file,
        diagnostics.filter((diagnostic) => (diagnostic.severity ?? 1) === 1),
      );
    }
    return found;
  }
}

function keyOf(declaration: Declaration): string {
  return `${declaration.file}:${declaration.line}:${declaration.character}`;
}
