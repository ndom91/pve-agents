import { type Harness, harness, register } from "../domain/harness";
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
export const LEGACY_SNAPSHOT_HARNESS = claudeCode.name;

// What a controller runs when its configuration does not say.
//
// Deliberately a second constant holding the same value as LEGACY_SNAPSHOT_HARNESS rather than one
// shared between them. They answer different questions and will stop agreeing: the historical fact
// about old snapshots is fixed forever, and this one moves the day a controller should default to
// something else.
export const DEFAULT_HARNESS = claudeCode.name;

// configuredHarness is which agent this controller runs, from its configuration.
//
// One expression in one place rather than the same lookup at each call site. Selection is
// controller-wide today; when it becomes per workspace this is the function that grows a second
// argument, which is the whole reason it exists.
//
// Structural rather than typed as ControllerConfig, because config imports this module to check
// the name against the registry and the two must not import each other.
export function configuredHarness(config: {
	WORKSPACE_AGENT_HARNESS: string;
}): Harness {
	return harness(config.WORKSPACE_AGENT_HARNESS);
}

export type { Harness, HarnessFile, MergeRule } from "../domain/harness";
export { harness, harnessNames } from "../domain/harness";
