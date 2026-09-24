/**
 * invariant.lock: the digest of the program `invariant compile` wrote.
 *
 * Written beside the program, and committed with it, so the program a person
 * reviewed is named by its digest. A runtime given that digest refuses any
 * other program at load (`programDigest` in createRuntime), which is what
 * stops one edited or swapped between the build and the server from being
 * served. It is the digest the evolution bundle records as
 * `compiled.programDigest`, so the two can be compared too.
 */
import { digestOf } from "@invariant-app/contract";
import { type JsonValue, withoutProvenance } from "@invariant-app/ir";

export const LOCK_FILE = "invariant.lock";

export interface Lock {
  /** The program's file name, beside the lock. */
  program: string;
  programDigest: string;
}

export function lockFor(program: { compiledBy?: string }, file: string): Lock {
  return {
    program: file,
    programDigest: digestOf(withoutProvenance(program) as unknown as JsonValue),
  };
}

export function renderLock(lock: Lock): string {
  return `${JSON.stringify(lock, null, 2)}\n`;
}
