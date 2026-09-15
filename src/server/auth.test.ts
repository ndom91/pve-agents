import { describe, expect, it } from "vitest";

import { controllerConfig } from "../config/controller-config";
import { operatorGate } from "./auth";

const OPERATOR_ID = "1234567";

describe("operatorGate", () => {
	it("admits the configured operator", () => {
		expect(gate({ id: Number(OPERATOR_ID), login: "ndom91" })).toBeUndefined();
	});

	it("admits the operator id whether GitHub sends it as a number or a string", () => {
		expect(gate({ id: OPERATOR_ID })).toBeUndefined();
		expect(gate({ id: Number(OPERATOR_ID) })).toBeUndefined();
	});

	it("rejects any other account on every path better-auth can take", () => {
		// create-user, link-account, and sign-in all run this hook. A gate that only covered
		// account creation would let a pre-existing account keep signing in.
		for (const action of ["create-user", "link-account", "sign-in"] as const) {
			expect(gate({ id: 7654321, login: "someone-else" }, action)).toEqual({
				error: "not_the_controller_operator",
			});
		}
	});

	it("rejects an account whose login matches but whose id does not", () => {
		// A GitHub login can be released and claimed by someone else. The immutable numeric id is
		// what the allow-list has to match on.
		expect(gate({ id: 999, login: "ndom91" })).toEqual({
			error: "not_the_controller_operator",
		});
	});

	it("rejects a profile with no id rather than defaulting to allow", () => {
		expect(gate({ login: "ndom91" })).toEqual({
			error: "github_profile_missing_id",
		});
		expect(gate({ id: null })).toEqual({ error: "github_profile_missing_id" });
	});

	it("rejects when no oauth profile is present at all", () => {
		expect(operatorGate(config())({ source: { action: "sign-in" } })).toEqual({
			error: "github_profile_missing_id",
		});
	});
});

function gate(
	profile: Record<string, unknown>,
	action: "create-user" | "link-account" | "sign-in" = "create-user",
) {
	return operatorGate(config())({ source: { action, oauth: { profile } } });
}

function config() {
	return controllerConfig({ CONTROLLER_OPERATOR_GITHUB_ID: OPERATOR_ID });
}
