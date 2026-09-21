/**
 * What the product would ship for a release, drafted the way a provider with
 * no decisions made would get it: the rules judge proposes Changes from the
 * two specifications, and they are compiled into the program the runtime
 * serves the old contract with. Shared by every rig that puts traffic through
 * an adapter, so that they all measure the same thing.
 */
import { chainProgram, type ProjectionIssue, predictDocument } from "@invariant/compiler";
import type { OpenApiDocument } from "@invariant/contract";
import { breakingEntries, diffDocuments } from "@invariant/diff";
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
  const issues = [...chained.issues, ...(await closureIssues(from, to, changes))];
  return { changes, program: chained.program, issues };
}

/**
 * Why the gate would block these drafts on closure: the prediction could not
 * be made, or it leaves breaking changes unexplained. A rig measures a program
 * a provider could ship, so it checks this itself rather than trusting a
 * recorded run made with older drafts.
 */
async function closureIssues(
  from: OpenApiDocument,
  to: OpenApiDocument,
  changes: Change[],
): Promise<ProjectionIssue[]> {
  const prediction = predictDocument(from, to, changes);
  if (prediction.issues.length > 0) return prediction.issues;
  try {
    const left = breakingEntries(await diffDocuments(prediction.document, to));
    if (left.length === 0) return [];
    const kinds = [...new Set(left.map((entry) => entry.id))].slice(0, 3).join(", ");
    return [
      {
        changeId: "closure",
        message: `the drafts leave ${left.length} breaking changes unexplained (${kinds})`,
      },
    ];
  } catch (error) {
    return [
      {
        changeId: "closure",
        message: `closure could not be checked: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
      },
    ];
  }
}
