import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as agent from "./agent.functions";
import * as orphan from "./orphan.functions";
import * as session from "./session.functions";
import * as settings from "./settings.functions";
import * as status from "./status.functions";
import * as workspace from "./workspace.functions";

// These two rules are what a server function's wrapper is for: it runs behind the operator guard,
// and it is reachable by the method its effect deserves. Neither can be checked by calling one —
// the callable a test imports is the client-side stub, and the middleware lives in a server build
// this process never loads.
//
// So they are checked the two ways that remain: the method off the stub, which is real runtime
// state, and the guard out of the source, which is not clever but does catch the thing that
// actually goes wrong. Somebody adds an endpoint in a hurry and does not attach the middleware.

const SERVER_DIR = join(import.meta.dirname, ".");

// UNGUARDED names the server functions that must work without a session, and why.
//
// An allow-list rather than a skipped file: the point is that adding another one is a decision
// somebody has to write down here, next to the reason the existing one is allowed.
const UNGUARDED = new Map([
	[
		"sessionState",
		"the route guard calls it to decide whether to redirect to the login page, so requiring a session would make signing in impossible",
	],
]);

describe("server function guards", () => {
	for (const file of functionModules()) {
		const source = readFileSync(join(SERVER_DIR, file), "utf8");

		for (const [name, chain] of serverFunctions(source)) {
			it(`${file}: ${name} runs behind the operator guard`, () => {
				if (UNGUARDED.has(name)) {
					expect(chain).not.toContain("operatorMiddleware");

					return;
				}

				expect(chain).toContain(".middleware([operatorMiddleware])");
			});
		}
	}

	for (const file of functionModules()) {
		const source = readFileSync(join(SERVER_DIR, file), "utf8");

		for (const [name, chain] of serverFunctions(source)) {
			// Both directions, because each is a different mistake. A handler that reads `data`
			// without a validator takes whatever the network sent, unchecked and mistyped as the
			// shape it expected. A validator on a handler that ignores `data` is a schema nobody
			// applies, which reads like a guarantee and is not one.
			it(`${file}: ${name} validates its input exactly when it has some`, () => {
				expect(chain.includes(".validator(")).toBe(readsData(chain));
			});
		}
	}

	it("covers every server function module in the directory", () => {
		// The scan is only worth anything if it finds the files. A rename that silently matched
		// nothing would leave every assertion above passing against an empty list.
		expect(functionModules().length).toBeGreaterThanOrEqual(6);
	});
});

// READ_ONLY is every server function that may be a GET.
//
// Stated as the exhaustive set rather than a rule about names, so a new one has to be classified
// deliberately. A mutation reachable by GET is prefetchable and cacheable, and "destroy" is on the
// other side of that line.
const READ_ONLY = new Set([
	"controllerStatus",
	"listWorkspaces",
	"scanOrphans",
	"sessionState",
	"workspaceChanges",
	"workspaceDetail",
	"workspaceFileDiff",
	"workspaceSettings",
]);

describe("server function methods", () => {
	for (const [name, method] of declaredMethods()) {
		it(`${name} is ${READ_ONLY.has(name) ? "a GET" : "a POST"}`, () => {
			expect(method).toBe(READ_ONLY.has(name) ? "GET" : "POST");
		});
	}

	it("sees every server function the modules export", () => {
		// Seventeen today. It was nineteen before Herdr went: reading a screen and sending a
		// keystroke were two of them, and answering an approval replaced both. The number is here
		// so that losing one to a bad import fails loudly rather than quietly shrinking what the
		// loop above covers.
		expect(declaredMethods().length).toBe(18);
	});
});

// functionModules lists the server function modules on disk rather than a hand-kept list, so a new
// one is covered by these rules the moment it exists.
function functionModules(): string[] {
	return readdirSync(SERVER_DIR)
		.filter((file) => file.endsWith(".functions.ts"))
		.sort();
}

// serverFunctions pulls each definition out of a module's source, from its name through the line
// its handler opens on.
//
// Non-greedy to the first `.handler(`, which is what keeps one definition from swallowing the
// next. The rest of that line is included because the handler's own arguments are what say whether
// the function takes input at all.
function serverFunctions(source: string): [string, string][] {
	return [
		...source.matchAll(
			/export const (\w+) = createServerFn\([\s\S]*?\.handler\([^\n]*/g,
		),
	].map((match) => [match[1] ?? "", match[0]]);
}

// readsData reports whether a definition's handler takes the validated input.
//
// The handler line only, not the whole chain: every definition with a validator mentions `data` in
// the schema it declares, so looking at all of it would answer its own question.
function readsData(chain: string): boolean {
	return (chain.split(".handler(").pop() ?? "").includes("data");
}

// declaredMethods reads the method off each imported server function.
//
// Real runtime state rather than source: this is the value the client actually sends with.
function declaredMethods(): [string, string][] {
	const modules = { agent, orphan, session, settings, status, workspace };

	return Object.values(modules).flatMap((module) =>
		Object.entries(module).flatMap(([name, value]): [string, string][] => {
			const method = (value as { method?: unknown }).method;

			return typeof value === "function" && typeof method === "string"
				? [[name, method]]
				: [];
		}),
	);
}
