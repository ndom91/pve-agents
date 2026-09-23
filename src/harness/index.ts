import { harness, harnessNames, register } from "../domain/harness";
import { claudeCode } from "./claude-code";
import { opencode2 } from "./opencode2";

// Registering every harness the controller can run.
//
// One module doing it, imported for its side effect, so a harness is added by writing a directory
// and one line here rather than by being discovered. Discovery would make "which agents does this
// build support" a question you answer by running it.
register(claudeCode);
register(opencode2);

// What a runner installed before the snapshot carried a harness name must be.
//
// Not a general fallback: it is the answer to one specific question, which is what those older
// runners were, and they were all this. A harness name that is merely unknown still throws.
export const LEGACY_SNAPSHOT_HARNESS = claudeCode.name;

// What a workspace with no harness recorded against it must have run.
//
// Every workspace created before harnesses became rows ran claude-code, because that is the only
// thing this controller could run. Distinct from the constant above even though they hold the same
// string: one is a fact about old snapshots, the other about old workspace rows, and they will stop
// agreeing the moment either kind of history is cleaned up.
export const LEGACY_WORKSPACE_HARNESS = claudeCode.name;

// anyHarnessMerges says whether any registered agent merges into a seeded destination.
//
// Seed files are configured once and applied to every new workspace, so at the moment one is saved
// there is no workspace and therefore no harness to ask. The union is the honest answer: validate it
// as JSON if it could be merged by anything, because the alternative is accepting a file that is
// valid for the harness the operator had in mind and corrupt for the one they later pick.
export function anyHarnessMerges(path: string): boolean {
	return harnessNames().some((name) => harness(name).merges(path));
}

export type { Harness, HarnessFile, MergeRule } from "../domain/harness";
export { harness, harnessNames } from "../domain/harness";
