/**
 * What the product would ship for a release, drafted the way a provider with
 * no decisions made would get it: the rules judge proposes Changes from the
 * two specifications, and they are compiled into the program the runtime
 * serves the old contract with. Shared by every rig that puts traffic through
 * an adapter, so that they all measure the same thing.
 */
import { chainProgram, type ProjectionIssue } from "@invariant/compiler";
import type { OpenApiDocument } from "@invariant/contract";
import type { Change } from "@invariant/ir";
import { propose, RulesJudge } from "@invariant/proposer";

/** The label the old contract is compiled under, and the one callers name. */
export const OLD = "old";
export const NEW = "new";

export interface Drafted {
  changes: Change[];
  program: unknown;
  /** Why the gate would block this release, if it would. */
  issues: ProjectionIssue[];
}

export async function draftProgram(
  api: string,
  from: OpenApiDocument,
  to: OpenApiDocument,
): Promise<Drafted> {
  const drafted = await propose(from, to, { judge: new RulesJudge() });
  const changes = drafted.proposals.map((proposal) => proposal.change);
  const chained = chainProgram(api, NEW, `sha256:${api}-proving`, [
    { label: NEW, parent: OLD, from, to, changes },
  ]);
  return { changes, program: chained.program, issues: chained.issues };
}
