import { register } from "../domain/harness";
import { claudeCode } from "./claude-code";

// Registering every harness the controller can run.
//
// One module doing it, imported for its side effect, so a harness is added by writing a directory
// and one line here rather than by being discovered. Discovery would make "which agents does this
// build support" a question you answer by running it.
register(claudeCode);

// What a runner installed before the snapshot carried a harness name must be.
//
// Not a general fallback: it is the answer to one specific question, which is what those older
// runners were, and they were all this. A harness name that is merely unknown still throws.
export const DEFAULT_HARNESS = claudeCode.name;

export type { Harness, HarnessFile } from "../domain/harness";
export { harness, harnessNames } from "../domain/harness";
