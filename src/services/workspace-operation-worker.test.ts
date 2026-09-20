import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type Database from "better-sqlite3";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import { controllerConfig } from "../config/controller-config";
import { openDatabase } from "../db/database";
import {
	createWorkspace,
	requestWorkspaceOperation,
} from "../db/workspace-repository";
import type { Fetcher } from "./proxmox-http";
import { ownershipMarker } from "./proxmox-ownership";
import type { SshResult, SshRunner } from "./ssh";
import { runWorkspaceOperations } from "./workspace-operation-worker";

// Records which addresses had their pinned key dropped, so the test can assert it happened without
// spawning a real ssh-keygen against a real known_hosts file.
const forgotten: string[] = [];

vi.mock("./ssh", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./ssh")>();

	return {
		...actual,
		forgetHost: async (_keyPath: string, address: string) => {
			forgotten.push(address);
		},
	};
});

const CONTROLLER_ID = "b66d3c5d-22c6-4199-889e-764f12d37fe5";
const UPID = "UPID:nas:0000A1B2:00C3D4E5:65F00000:vzclone:109:root@pam:";
const SHUTDOWN_UPID =
	"UPID:nas:0000A1B3:00C3D4E5:65F00001:vzshutdown:109:root@pam:";
const START_UPID = "UPID:nas:0000A1B6:00C3D4E5:65F00004:vzstart:109:root@pam:";
const STOP_UPID = "UPID:nas:0000A1B4:00C3D4E5:65F00002:vzstop:109:root@pam:";
const DELETE_UPID =
	"UPID:nas:0000A1B5:00C3D4E5:65F00003:vzdestroy:109:root@pam:";

// Every helper pins the controller clock so that a later poll is past the release delay but well
// inside the clone deadline. Left to the wall clock, every test would read as a timed-out task.
const SUBMITTED_AT = new Date("2026-01-01T00:00:00Z");
const POLLED_AT = new Date("2026-01-01T00:00:10Z");

const APP_KEY_PATH = join(tmpdir(), "pve-agents-worker-app.pem");

const databases: Database.Database[] = [];
let ticks = 0;

// The checkout step signs a GitHub App assertion before it makes any request, so a real key is
// needed even though every request is faked.
beforeAll(() => {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { format: "pem", type: "pkcs1" },
		publicKeyEncoding: { format: "pem", type: "spki" },
	});
	writeFileSync(APP_KEY_PATH, privateKey, { mode: 0o600 });
});

beforeEach(() => {
	ticks = 0;
	forgotten.length = 0;
});

afterEach(() => {
	for (const db of databases) {
		db.close();
	}

	databases.length = 0;
});

describe("runWorkspaceOperations", () => {
	it("does not execute queued operations by default", async () => {
		const db = database();

		expect(await runWorkspaceOperations(db, controllerConfig({}))).toEqual({
			processed: 0,
			status: "disabled",
		});
	});

	it("persists clone recovery points around one provision request", async () => {
		const db = database();
		const workspaceID = workspace(db);

		const result = await runWorkspaceOperations(db, config(), async (url) => {
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "109" });
			}

			return Response.json({ data: UPID });
		});

		expect(result).toEqual({ processed: 1, status: "clone_submitted" });
		expect(
			db
				.prepare("SELECT vmid, current_task_upid FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_task_upid: UPID, vmid: 109 });
	});

	it("confirms a clone once Proxmox reports success", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "clone_confirmed" });
		expect(
			db
				.prepare(
					"SELECT status, current_step, current_task_upid FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toEqual({
			current_step: "clone confirmed",
			current_task_upid: null,
			status: "provisioning",
		});
	});

	it("carries one workspace from a clone to a running agent", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const confirmed = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
			POLLED_AT,
		);
		expect(confirmed).toEqual({ processed: 1, status: "clone_confirmed" });

		const started = await runWorkspaceOperations(
			db,
			config(),
			async () => Response.json({ data: START_UPID }),
			new Date(POLLED_AT.getTime() + 60_000),
		);
		expect(started).toEqual({ processed: 1, status: "start_submitted" });
		expect(workspaceStatus(db, workspaceID)).toBe("booting");

		const booted = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
			new Date(POLLED_AT.getTime() + 120_000),
		);
		expect(booted).toEqual({ processed: 1, status: "container_booted" });

		const addressed = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({
					data: [
						{ inet: "127.0.0.1/8", name: "lo" },
						{ inet: "10.0.3.101/24", name: "eth0" },
					],
				}),
			new Date(POLLED_AT.getTime() + 180_000),
		);
		expect(addressed).toEqual({ processed: 1, status: "address_found" });
		expect(
			db.prepare("SELECT ip FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ ip: "10.0.3.101" });

		const reachable = await runWorkspaceOperations(
			db,
			config(),
			async () => {
				throw new Error("proxmox must not be contacted for ssh readiness");
			},
			new Date(POLLED_AT.getTime() + 240_000),
			async (target) => {
				expect(target.address).toBe("10.0.3.101");
				expect(target.user).toBe("agent");

				return { code: 0, kind: "ran", stderr: "", stdout: "" };
			},
		);
		expect(reachable).toEqual({ processed: 1, status: "ssh_ready" });

		const workspace = runnerWorkspace();
		const step = async (at: number) =>
			runWorkspaceOperations(
				db,
				config(),
				async () => {
					throw new Error("proxmox must not be contacted for agent steps");
				},
				new Date(POLLED_AT.getTime() + at),
				workspace.ssh,
			);

		expect(await step(300_000)).toEqual({
			processed: 1,
			status: "bootstrapped",
		});

		// Mints a repo-scoped token and clones, which is the only step that talks to GitHub.
		expect(
			await runWorkspaceOperations(
				db,
				config(),
				github,
				new Date(POLLED_AT.getTime() + 330_000),
				workspace.ssh,
			),
		).toEqual({ processed: 1, status: "checked_out" });
		// The server is launched detached, so the pass that starts it cannot also confirm it. It
		// takes a second pass to observe the socket listening.
		expect(await step(360_000)).toEqual({
			processed: 1,
			status: "awaiting_session",
		});
		expect(await step(420_000)).toEqual({
			processed: 1,
			status: "session_started",
		});
		// The workspace is only "ready" once it has been told what it was requested for.
		expect(await step(480_000)).toEqual({
			processed: 1,
			status: "workspace_ready",
		});

		// The timeline is where an operator follows this, so every milestone has to land in it.
		expect(
			db
				.prepare(
					"SELECT event_type FROM workspace_events WHERE workspace_id = ? ORDER BY id",
				)
				.all(workspaceID)
				.map((row) => (row as { event_type: string }).event_type),
		).toEqual([
			"workspace.requested",
			"workspace.clone_confirmed",
			"workspace.booted",
			"workspace.addressed",
			"workspace.reachable",
			"workspace.bootstrapped",
			"workspace.checked_out",
			"workspace.session_started",
			"workspace.ready",
		]);

		expect(workspaceStatus(db, workspaceID)).toBe("ready");

		const settled = await runWorkspaceOperations(
			db,
			config(),
			async () => {
				throw new Error("proxmox must not be contacted again");
			},
			new Date(POLLED_AT.getTime() + 540_000),
			async () => {
				throw new Error("ssh must not be attempted again");
			},
		);
		expect(settled).toEqual({ processed: 0, status: "empty" });
		expect(
			db
				.prepare(
					"SELECT event_type FROM workspace_events WHERE workspace_id = ? ORDER BY id",
				)
				.all(workspaceID)
				.map((row) => (row as { event_type: string }).event_type),
		).toEqual([
			"workspace.requested",
			"workspace.clone_confirmed",
			"workspace.booted",
			"workspace.addressed",
			"workspace.reachable",
			"workspace.bootstrapped",
			"workspace.checked_out",
			"workspace.session_started",
			"workspace.ready",
		]);
		expect(
			db
				.prepare(
					"SELECT count(*) c FROM workspace_events WHERE workspace_id = ? AND event_type = ?",
				)
				.get(workspaceID, "workspace.clone_confirmed"),
		).toEqual({ c: 1 });
	});

	it("will not call a workspace ready while its runner is not answering", async () => {
		// The rule that replaced the first-run wizard checks. Claude Code's TUI had three gates a
		// controller had to recognise on a rendered screen; the SDK has none, so the only question
		// left is whether a process is listening. A runner that launches and dies -- a missing
		// dependency, a bad credential -- launches perfectly, so the launch cannot be the proof.
		const db = database();
		const workspaceID = await addressed(db);
		const proxmox = async () => {
			throw new Error("proxmox must not be contacted");
		};

		// A container where the runner never comes up: every liveness probe fails.
		const dead: SshRunner = async (_target, args) => {
			const command = args.join(" ");

			return command.includes('net").connect')
				? { code: 1, kind: "ran", stderr: "", stdout: "" }
				: { code: 0, kind: "ran", stderr: "", stdout: "" };
		};

		await tick(db, proxmox, dead); // addressed -> reachable
		await tick(db, proxmox, dead); // -> bootstrapped
		await tick(db, github, dead); // -> checked-out
		const waiting = await tick(db, proxmox, dead);

		// Held, not failed: a runner can legitimately be slow to bind, and the operation deadline
		// is what bounds the waiting. What must not happen is the workspace being handed over.
		expect(waiting).toEqual({ processed: 1, status: "awaiting_session" });
		expect(workspaceStatus(db, workspaceID)).not.toBe("ready");
	});

	it("reaches ready without a purpose, and says so", async () => {
		// A workspace requested without one is ready and idle, waiting for somebody to tell it
		// something from the page. The asserted outcome rather than a pass count: the number of
		// passes this takes has changed with every phase added, and each time the failure landed
		// somewhere that had nothing to do with the rule being checked.
		const db = database();
		const workspaceID = await provisioned(db, null);

		expect(workspaceStatus(db, workspaceID)).toBe("ready");
		expect(
			db
				.prepare(
					"SELECT message FROM workspace_events WHERE workspace_id = ? ORDER BY id DESC LIMIT 1",
				)
				.get(workspaceID),
		).toEqual({ message: "workspace ready, awaiting instructions" });
	});

	it("will not call a workspace ready while its runner is not answering", async () => {
		// The rule that replaced the first-run wizard checks. Claude Code's TUI had three gates a
		// controller had to recognise on a rendered screen; the SDK has none, so the only question
		// left is whether a process is listening. A runner that launches and dies -- a missing
		// dependency, a bad credential -- launches perfectly, so the launch cannot be the proof.
		const db = database();
		const workspaceID = await addressed(db);
		const proxmox = async () => {
			throw new Error("proxmox must not be contacted");
		};

		// A container where the runner never comes up: every liveness probe fails.
		const dead: SshRunner = async (_target, args) => {
			const command = args.join(" ");

			return command.includes('net").connect')
				? { code: 1, kind: "ran", stderr: "", stdout: "" }
				: { code: 0, kind: "ran", stderr: "", stdout: "" };
		};

		await tick(db, proxmox, dead); // addressed -> reachable
		await tick(db, proxmox, dead); // -> bootstrapped
		await tick(db, github, dead); // -> checked-out
		const waiting = await tick(db, proxmox, dead);

		// Held, not failed: a runner can legitimately be slow to bind, and the operation deadline
		// is what bounds the waiting. What must not happen is the workspace being handed over.
		expect(waiting).toEqual({ processed: 1, status: "awaiting_session" });
		expect(workspaceStatus(db, workspaceID)).not.toBe("ready");
	});

	it("briefs the agent with the purpose it was requested for, verbatim", async () => {
		const db = database();
		const workspace = runnerWorkspace();

		// Observed from inside the provision rather than after it. The briefing is a step of
		// becoming ready, so there is no moment afterwards at which it is still about to happen.
		let sent = "";
		let argv = "";
		await provisioned(
			db,
			"a stated purpose",
			async (target, command, input) => {
				if ((input ?? "").includes('"type":"prompt"')) {
					sent = input ?? "";
					argv = command.join(" ");
				}

				return workspace.ssh(target, command, input);
			},
		);

		// Verbatim: wrapping it would hand the agent instructions nobody wrote.
		expect(JSON.parse(sent.split("\n")[0] ?? "")).toEqual({
			text: "a stated purpose",
			type: "prompt",
		});
		// And on stdin, never in argv. A purpose is operator text that may contain anything, and
		// arguments are visible in ps on the workspace for as long as the command runs.
		expect(argv).not.toContain("a stated purpose");
	});

	it("clears a stale host key before first reaching a workspace", async () => {
		// DHCP hands out the low addresses of the range repeatedly, so a new workspace inheriting a
		// destroyed one's address is routine. Its host keys are generated on first boot, so the
		// pinned key never matches and ssh refuses with a host-key warning that reads like an
		// attack. Forgetting only on destroy was not enough: one missed cleanup poisons the next
		// workspace handed that address, which is exactly what happened.
		const db = database();
		const workspaceID = await addressed(db);

		const result = await tick(
			db,
			async () => {
				throw new Error("proxmox must not be contacted");
			},
			async () => ({ code: 0, kind: "ran", stderr: "", stdout: "" }),
		);

		expect(result).toEqual({ processed: 1, status: "ssh_ready" });
		expect(forgotten).toContain("10.0.3.101");
		expect(workspaceStatus(db, workspaceID)).toBe("booting");
	});

	it("keeps waiting while sshd is still coming up", async () => {
		const db = database();
		const workspaceID = await addressed(db);

		const result = await tick(
			db,
			async () => {
				throw new Error("proxmox must not be contacted");
			},
			async () => ({ kind: "refused" }),
		);

		// sshd starts after the container boots, so a refused connection is ordinary.
		expect(result).toEqual({ processed: 1, status: "awaiting_ssh" });
		expect(workspaceStatus(db, workspaceID)).toBe("booting");
	});

	it("fails the workspace when ssh rejects the controller", async () => {
		const db = database();
		const workspaceID = await addressed(db);

		const result = await tick(
			db,
			async () => {
				throw new Error("proxmox must not be contacted");
			},
			async () => ({
				kind: "rejected",
				message: "Permission denied (publickey).",
			}),
		);

		// A rejected key will not start working on its own, and retrying buries the reason under
		// an hour of identical attempts.
		expect(result).toEqual({ processed: 1, status: "task_failed" });
		expect(
			db
				.prepare(
					"SELECT status, error_code, error_message FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toEqual({
			error_code: "ssh_rejected",
			error_message: "Permission denied (publickey).",
			status: "failed",
		});
	});

	it("keeps waiting when the remote command itself fails", async () => {
		const db = database();
		await addressed(db);

		const result = await tick(
			db,
			async () => {
				throw new Error("proxmox must not be contacted");
			},
			async () => ({ code: 1, kind: "ran", stderr: "", stdout: "" }),
		);

		// The connection worked but the box is not settled yet; that is not a credential problem.
		expect(result).toEqual({ processed: 1, status: "awaiting_ssh" });
	});

	it("fails the workspace when the start task fails", async () => {
		const db = database();
		const workspaceID = await confirmed(db);

		await tick(db, async () => Response.json({ data: START_UPID }));
		const result = await tick(db, async () =>
			Response.json({
				data: { exitstatus: "unable to start CT 109", status: "stopped" },
			}),
		);

		// A container that will not boot is a dead workspace, not something to keep retrying.
		expect(result).toEqual({ processed: 1, status: "task_failed" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: "start_task_failed", status: "failed" });
	});

	it("retries a start request that never reached Proxmox", async () => {
		const db = database();
		const workspaceID = await confirmed(db);

		const result = await tick(db, async () => {
			throw new Error("ECONNREFUSED");
		});

		// The request failed rather than the boot, so the workspace stays provisioning and the
		// reason reaches the timeline.
		expect(result).toEqual({ processed: 1, status: "request_failed" });
		expect(workspaceStatus(db, workspaceID)).toBe("provisioning");
		expect(
			db
				.prepare(
					"SELECT count(*) c FROM workspace_events WHERE workspace_id = ? AND event_type = ?",
				)
				.get(workspaceID, "workspace.retrying"),
		).toEqual({ c: 1 });
	});

	it("keeps waiting while the clone task is still running", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => Response.json({ data: { status: "running" } }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_task" });
		expect(workspaceStatus(db, workspaceID)).toBe("provisioning");
		expect(
			db
				.prepare("SELECT status, next_run_at FROM workspace_operations")
				.get() as { next_run_at: string; status: string },
		).toMatchObject({ status: "queued" });
	});

	it("fails the workspace when the clone task reports a bad exit status", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({
					data: { exitstatus: "unable to create CT 109", status: "stopped" },
				}),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "task_failed" });
		expect(
			db
				.prepare(
					"SELECT status, error_code, error_message FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toEqual({
			error_code: "clone_task_failed",
			error_message: "proxmox task exited with unable to create CT 109",
			status: "failed",
		});
		expect(db.prepare("SELECT status FROM workspace_operations").get()).toEqual(
			{ status: "failed" },
		);
	});

	it("does not fail the workspace when polling hits a transient error", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 500 }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_task" });
		expect(workspaceStatus(db, workspaceID)).toBe("provisioning");
	});

	it("fails a task that never finishes before its deadline", async () => {
		const db = database();
		const workspaceID = await submitted(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => Response.json({ data: { status: "running" } }),
			new Date("2026-01-01T01:00:00Z"),
		);

		expect(result).toEqual({ processed: 1, status: "task_failed" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: "clone_task_timeout", status: "failed" });
	});

	it("adopts a candidate container whose ownership marker matches", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({
					data: {
						description: ownershipMarker({
							controllerID: CONTROLLER_ID,
							createdAt: "2026-01-01T00:00:00.000Z",
							ownershipToken: ownershipToken(db, workspaceID),
							workspaceID,
						}),
					},
				}),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_adopted" });
		expect(
			db
				.prepare("SELECT vmid, current_step FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_step: "clone confirmed", vmid: 109 });
	});

	it("abandons a candidate VMID whose container belongs to someone else", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () =>
				Response.json({
					data: {
						description: ownershipMarker({
							controllerID: "11111111-1111-1111-1111-111111111111",
							createdAt: "2026-01-01T00:00:00.000Z",
							ownershipToken: "22222222-2222-2222-2222-222222222222",
							workspaceID: "33333333-3333-3333-3333-333333333333",
						}),
					},
				}),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_released" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: null });
		expect(workspaceStatus(db, workspaceID)).toBe("provisioning");
	});

	it("never issues a write while reconciling an unverified container", async () => {
		const db = database();
		await lostCloneResponse(db);
		const methods: string[] = [];

		await runWorkspaceOperations(
			db,
			config(),
			async (_url, init) => {
				methods.push(init.method as string);

				return Response.json({ data: { description: "hand-written note" } });
			},
			POLLED_AT,
		);

		expect(methods).toEqual(["GET"]);
	});

	it("resumes a clone that was still running when its response was lost", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async (url) => {
				if (url.includes("/tasks?")) {
					return Response.json({
						data: [{ id: "109", type: "vzclone", upid: UPID }],
					});
				}

				return new Response("", { status: 404 });
			},
			POLLED_AT,
		);

		// The container is not visible yet, but the clone is in flight. Abandoning the VMID here
		// would leave it as an orphan carrying this workspace's ownership marker.
		expect(result).toEqual({ processed: 1, status: "task_recovered" });
		expect(
			db
				.prepare("SELECT vmid, current_task_upid FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_task_upid: UPID, vmid: 109 });
	});

	it("abandons a candidate VMID the token cannot read and does not own", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async (url) => {
				if (url.includes("/pools/")) {
					return Response.json({ data: { members: [] } });
				}

				return new Response("Permission check failed", { status: 403 });
			},
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_released" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: null });
	});

	it("ignores an unrelated running task on the same VMID", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async (url) => {
				if (url.includes("/tasks?")) {
					return Response.json({
						data: [{ id: "109", type: "vzstart", upid: UPID }],
					});
				}

				return new Response("", { status: 404 });
			},
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_released" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: null });
	});

	it("abandons a candidate VMID when no container was ever created", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async (url) => {
				if (url.includes("/tasks?")) {
					return Response.json({ data: [] });
				}

				return new Response("", { status: 404 });
			},
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "vmid_released" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: null });
	});

	it("retries reconciliation when the inspection request fails", async () => {
		const db = database();
		const workspaceID = await lostCloneResponse(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("permission denied", { status: 500 }),
			POLLED_AT,
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_reconciliation" });
		expect(
			db.prepare("SELECT vmid FROM workspaces WHERE id = ?").get(workspaceID),
		).toEqual({ vmid: 109 });
	});
});

describe("runWorkspaceOperations destroying a workspace", () => {
	it("shuts a running container down before deleting it", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		const shutdown = await tick(db, proxmox(db, workspaceID, { calls }));
		expect(shutdown).toEqual({ processed: 1, status: "shutdown_submitted" });
		expect(calls).toEqual([
			"GET /config",
			"GET /status/current",
			"POST /status/shutdown",
		]);

		await tick(db, proxmox(db, workspaceID, { task: "OK" }));
		expect(destroyPhase(db, workspaceID)).toBe("shutdown-tried");

		const remove = await tick(
			db,
			proxmox(db, workspaceID, { state: "stopped" }),
		);
		expect(remove).toEqual({ processed: 1, status: "delete_submitted" });

		const done = await tick(db, proxmox(db, workspaceID, { task: "OK" }));
		expect(done).toEqual({ processed: 1, status: "container_deleted" });
		expect(
			db
				.prepare("SELECT status, destroyed_at FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toMatchObject({ status: "destroyed" });
	});

	it("deletes an already stopped container without shutting it down", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		const result = await tick(
			db,
			proxmox(db, workspaceID, { calls, state: "stopped" }),
		);

		expect(result).toEqual({ processed: 1, status: "delete_submitted" });
		expect(calls).toEqual([
			"GET /config",
			"GET /status/current",
			"DELETE /lxc",
		]);
	});

	it("escalates to a forced stop when clean shutdown fails", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		await tick(db, proxmox(db, workspaceID, {}));

		await tick(db, proxmox(db, workspaceID, { task: "timeout waiting" }));
		expect(destroyPhase(db, workspaceID)).toBe("shutdown-tried");

		const calls: string[] = [];
		const stop = await tick(db, proxmox(db, workspaceID, { calls }));

		expect(stop).toEqual({ processed: 1, status: "stop_submitted" });
		// State is re-read before escalating, so a guest that did stop after a failed shutdown
		// task goes straight to delete instead of being stopped pointlessly.
		expect(calls).toEqual([
			"GET /config",
			"GET /status/current",
			"POST /status/stop",
		]);
	});

	it("force stops a guest still running after its shutdown reported success", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		await tick(db, proxmox(db, workspaceID, {}));
		await tick(db, proxmox(db, workspaceID, { task: "OK" }));
		expect(destroyPhase(db, workspaceID)).toBe("shutdown-tried");

		// The task succeeded but the guest is still up. Asking it to shut down again would cycle
		// shutdown -> confirm -> shutdown until the operation deadline.
		const calls: string[] = [];
		const result = await tick(
			db,
			proxmox(db, workspaceID, { calls, state: "running" }),
		);

		expect(result).toEqual({ processed: 1, status: "stop_submitted" });
		expect(calls).toEqual([
			"GET /config",
			"GET /status/current",
			"POST /status/stop",
		]);
	});

	it("treats an absent container as a successful destruction", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		const result = await tick(
			db,
			async () => new Response("", { status: 404 }),
		);

		expect(result).toEqual({ processed: 1, status: "container_missing" });
		expect(workspaceStatus(db, workspaceID)).toBe("destroyed");
	});

	it("halts without issuing any write when ownership does not match", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		const result = await tick(
			db,
			proxmox(db, workspaceID, { calls, description: "hand-written note" }),
		);

		expect(result).toEqual({ processed: 1, status: "destroy_halted" });
		expect(calls).toEqual(["GET /config"]);
		expect(
			db
				.prepare(
					"SELECT status, error_code, error_retryable FROM workspaces WHERE id = ?",
				)
				.get(workspaceID),
		).toMatchObject({
			error_code: "destroy_ownership_mismatch",
			error_retryable: 0,
			status: "destroying",
		});
		expect(
			db
				.prepare(
					"SELECT status FROM workspace_operations WHERE kind = 'destroy'",
				)
				.get(),
		).toEqual({ status: "failed" });
	});

	it("cancels the in-flight provision when a destroy is requested", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		// Provisioning continues past a confirmed clone now, so there is a live operation to
		// cancel: left queued it would boot a container teardown is removing.
		expect(
			db
				.prepare(
					"SELECT status, error_message FROM workspace_operations WHERE kind = 'provision'",
				)
				.get(),
		).toEqual({
			error_message: "superseded by a destroy request",
			status: "cancelled",
		});

		// A cancelled provision must never run again; otherwise it could clone a replacement
		// container while teardown removes the original.
		await tick(db, async () => new Response("", { status: 404 }));
		expect(workspaceStatus(db, workspaceID)).toBe("destroyed");
		expect(
			await tick(db, async () => {
				throw new Error("no operation should remain claimable");
			}),
		).toEqual({ processed: 0, status: "empty" });
	});

	it("does not poll a cancelled clone task as though it were a teardown task", async () => {
		const db = database();
		// Destroy requested while the clone is still in flight: the workspace row still carries the
		// clone UPID, and both kinds share that one column.
		const workspaceID = await submitted(db);
		expect(requestWorkspaceOperation(db, workspaceID, "destroy").kind).toBe(
			"created",
		);
		expect(
			db
				.prepare("SELECT current_task_upid FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ current_task_upid: null });

		// A failed clone task must not halt teardown. Teardown re-inspects Proxmox instead.
		const result = await tick(
			db,
			proxmox(db, workspaceID, { state: "stopped", task: "clone failed" }),
		);

		expect(result).toEqual({ processed: 1, status: "delete_submitted" });
		expect(workspaceStatus(db, workspaceID)).toBe("destroying");
	});

	it("halts on a container this controller owns but for a different workspace", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		const calls: string[] = [];

		// managed-by and controller-id both match; only workspace-id and the token differ. This is
		// what VMID reuse produces on real hardware, and it is the case an unmarked-container test
		// cannot catch.
		const result = await tick(
			db,
			proxmox(db, workspaceID, {
				calls,
				description: ownershipMarker({
					controllerID: CONTROLLER_ID,
					createdAt: "2026-01-01T00:00:00.000Z",
					ownershipToken: "99999999-9999-9999-9999-999999999999",
					workspaceID: "88888888-8888-8888-8888-888888888888",
				}),
			}),
		);

		expect(result).toEqual({ processed: 1, status: "destroy_halted" });
		expect(calls).toEqual(["GET /config"]);
		expect(
			db
				.prepare("SELECT error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: "destroy_ownership_mismatch" });
	});

	it("does not fail a teardown on a transient Proxmox error", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		const result = await tick(
			db,
			async () => new Response("permission denied", { status: 500 }),
		);

		expect(result).toEqual({ processed: 1, status: "awaiting_reconciliation" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: null, status: "destroying" });
	});

	it("completes when the container is gone and the token cannot see it", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		// A pool-scoped token answers 403 for every guest outside its pool, so the pool listing is
		// what distinguishes "deleted" from "cannot reach Proxmox".
		const result = await tick(db, async (url) => {
			if (url.includes("/pools/")) {
				return Response.json({ data: { members: [] } });
			}

			return new Response("Permission check failed", { status: 403 });
		});

		expect(result).toEqual({ processed: 1, status: "container_missing" });
		expect(workspaceStatus(db, workspaceID)).toBe("destroyed");
	});

	it("halts when the container is in the pool but unreadable", async () => {
		const db = database();
		const workspaceID = await destroyable(db);

		const result = await tick(db, async (url) => {
			if (url.includes("/pools/")) {
				return Response.json({ data: { members: [{ vmid: 109 }] } });
			}

			return new Response("Permission check failed", { status: 403 });
		});

		// Present but unreadable is a permission fault, not an absent container. Claiming it was
		// destroyed would be a lie.
		expect(result).toEqual({ processed: 1, status: "destroy_halted" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({ error_code: "destroy_forbidden", status: "destroying" });
	});

	it("claims a destroy ahead of another workspace's queued provision", async () => {
		const db = database();
		const destroying = await destroyable(db);
		createWorkspace(db, {
			idempotencyKey: "request-b",
			repository: "https://github.com/plainhq/other.git",
			ref: "main",
		});

		const result = await tick(
			db,
			async () => new Response("", { status: 404 }),
		);

		expect(result).toEqual({ processed: 1, status: "container_missing" });
		expect(workspaceStatus(db, destroying)).toBe("destroyed");
	});

	it("rejects a second destroy request once the workspace is destroyed", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		await tick(db, async () => new Response("", { status: 404 }));

		expect(requestWorkspaceOperation(db, workspaceID, "destroy").kind).toBe(
			"invalid_transition",
		);
	});

	it("destroys a workspace that never got as far as a container", async () => {
		const db = database();
		const workspaceID = workspace(db);
		expect(requestWorkspaceOperation(db, workspaceID, "destroy").kind).toBe(
			"created",
		);

		const result = await tick(db, async () => {
			throw new Error("proxmox must not be contacted");
		});

		expect(result).toEqual({ processed: 1, status: "container_missing" });
		expect(workspaceStatus(db, workspaceID)).toBe("destroyed");
	});
});

// proxmox builds a fetcher routing each teardown call to a canned response, optionally recording
// the request line so a test can assert exactly which actions were attempted.
function proxmox(
	db: Database.Database,
	workspaceID: string,
	options: {
		calls?: string[];
		description?: string;
		state?: "running" | "stopped";
		task?: string;
	},
): Fetcher {
	const description =
		options.description ??
		ownershipMarker({
			controllerID: CONTROLLER_ID,
			createdAt: "2026-01-01T00:00:00.000Z",
			ownershipToken: ownershipToken(db, workspaceID),
			workspaceID,
		});

	return async (url, init) => {
		const method = init.method as string;
		const record = (path: string) => options.calls?.push(`${method} ${path}`);

		if (url.includes("/tasks/")) {
			return Response.json({
				data: { exitstatus: options.task ?? "OK", status: "stopped" },
			});
		}
		if (url.endsWith("/config")) {
			record("/config");

			return Response.json({ data: { description } });
		}
		if (url.endsWith("/status/current")) {
			record("/status/current");

			return Response.json({ data: { status: options.state ?? "running" } });
		}
		if (url.endsWith("/status/shutdown")) {
			record("/status/shutdown");

			return Response.json({ data: SHUTDOWN_UPID });
		}
		if (url.endsWith("/status/stop")) {
			record("/status/stop");

			return Response.json({ data: STOP_UPID });
		}
		if (method === "DELETE") {
			record("/lxc");
			expect(url).toContain("purge=1");
			expect(url).not.toContain("destroy-unreferenced-disks");

			return Response.json({ data: DELETE_UPID });
		}

		throw new Error(`unexpected request ${method} ${url}`);
	};
}

// tick advances the clock a minute per pass, since an operation released to wait on Proxmox is
// deliberately not due again immediately.
function tick(db: Database.Database, fetcher: Fetcher, ssh?: SshRunner) {
	ticks += 1;

	return runWorkspaceOperations(
		db,
		config(),
		fetcher,
		new Date(POLLED_AT.getTime() + ticks * 60_000),
		ssh,
	);
}

function destroyPhase(
	db: Database.Database,
	workspaceID: string,
): string | null {
	return (
		db
			.prepare("SELECT destroy_phase FROM workspaces WHERE id = ?")
			.get(workspaceID) as { destroy_phase: string | null }
	).destroy_phase;
}

// confirmed leaves a workspace whose clone is confirmed and ready for the boot step.
async function confirmed(db: Database.Database): Promise<string> {
	const workspaceID = await submitted(db);
	await runWorkspaceOperations(
		db,
		config(),
		async () =>
			Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
		POLLED_AT,
	);

	return workspaceID;
}

// addressed leaves a workspace booted with a discovered address, ready for the ssh check.
async function addressed(db: Database.Database): Promise<string> {
	const workspaceID = await confirmed(db);
	await tick(db, async () => Response.json({ data: START_UPID }));
	await tick(db, async () =>
		Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
	);
	await tick(db, async () =>
		Response.json({ data: [{ inet: "10.0.3.101/24", name: "eth0" }] }),
	);

	return workspaceID;
}

// provisioned carries a workspace all the way from addressed to ready.
//
// It does not stop at a phase, because it cannot: advancing releases the operation with no delay,
// so one drain continues into the next step and where it lands depends on which step last asked to
// wait. A caller that wants to watch a particular step passes an ssh runner and observes it.
//
// purpose is nullable rather than optional: a default parameter also applies when undefined is
// passed explicitly, so "no purpose" has to be a value the default cannot swallow.
async function provisioned(
	db: Database.Database,
	purpose: string | null = "a stated purpose",
	ssh?: SshRunner,
): Promise<string> {
	const workspaceID = await addressed(db);
	db.prepare("UPDATE workspaces SET purpose = ? WHERE id = ?").run(
		purpose,
		workspaceID,
	);
	const workspace = runnerWorkspace();
	const run = ssh ?? workspace.ssh;

	// Driven until it settles rather than by a counted number of passes.
	//
	// One pass drains as many steps as are due, and which ones are due depends on whether the step
	// before it released with a delay. Counting passes here was wrong three separate times, and
	// each time the failure surfaced in a test that had nothing to do with the change.
	//
	// github is offered on every pass because exactly one step reaches it and the rest never ask.
	for (let pass = 0; pass < 12; pass += 1) {
		if (workspaceStatus(db, workspaceID) === "ready") {
			break;
		}
		await tick(db, github, run);
	}

	return workspaceID;
}

// destroyable leaves a workspace with a confirmed clone and a queued destroy request.
async function destroyable(db: Database.Database): Promise<string> {
	const workspaceID = await submitted(db);
	await runWorkspaceOperations(
		db,
		config(),
		async () =>
			Response.json({ data: { exitstatus: "OK", status: "stopped" } }),
		POLLED_AT,
	);
	if (
		requestWorkspaceOperation(db, workspaceID, "destroy").kind !== "created"
	) {
		throw new Error("expected destroy request");
	}

	return workspaceID;
}

function config() {
	return controllerConfig({
		CONTROLLER_AUTH_SECRET: "c".repeat(48),
		WORKSPACE_SSH_KEY_PATH: "/tmp/test-controller-key",
		CONTROLLER_ID,
		CONTROLLER_OPERATOR_GITHUB_ID: "1",
		GITHUB_CLIENT_ID: "github-client",
		GITHUB_CLIENT_SECRET: "github-secret",
		PROVISIONING_ENABLED: "true",
		PROXMOX_BRIDGE: "vmbr0",
		PROXMOX_NODE: "nas",
		PROXMOX_POOL: "disposable-workspaces",
		PROXMOX_TEMPLATE_VMID: "107",
		PROXMOX_TOKEN_ID: "workspace-controller@pve!controller",
		PROXMOX_TOKEN_SECRET: "not-a-real-secret",
		PROXMOX_URL: "https://nas.puff.lan:8006/api2/json",
		GITHUB_APP_ID: "123456",
		GITHUB_APP_INSTALLATION_ID: "7890",
		GITHUB_APP_PRIVATE_KEY_PATH: APP_KEY_PATH,
		WORKSPACE_CLAUDE_OAUTH_TOKEN: "not-a-real-token",
	});
}

// github fakes the installation-token endpoint, and refuses anything else.
const github: Fetcher = async (url) => {
	if (String(url).includes("api.github.com")) {
		return Response.json({
			expires_at: "2026-01-01T01:00:00Z",
			token: "ghs_worker_test_token",
		});
	}

	throw new Error(`unexpected request: ${url}`);
};

// runnerWorkspace fakes a workspace container running the agent runner, routing on the command.
//
// Stateful in the one respect that matters: the socket does not answer until the runner has been
// started, so the launch-then-confirm sequence is exercised rather than assumed away. A runner is
// backgrounded by the script that starts it, so the pass that launches one genuinely cannot also
// know whether it survived.
function runnerWorkspace() {
	let listening = false;

	const ssh: SshRunner = async (_target, args, input) => {
		const command = args.join(" ");
		const stdout = (text: string): SshResult => ({
			code: 0,
			kind: "ran",
			stderr: "",
			stdout: text,
		});

		// The reachability probe: the controller proves it can log in before anything else.
		if (command === "true") {
			return stdout("");
		}
		if (command.includes("hasCompletedOnboarding")) {
			return stdout("");
		}
		if (
			command.includes("credential.helper") ||
			command.includes("git clone") ||
			command.includes("user.name")
		) {
			return stdout("");
		}
		// Checked before the liveness probe below, and the order is the point: the start script
		// contains that probe too, as its own "already running?" guard. Matching the probe first
		// meant the launch never happened and the runner never came up.
		if (command.includes("setsid")) {
			listening = true;

			return stdout("started\n");
		}
		// The liveness probe, which is a connect rather than a test for the file: a socket left
		// behind by a runner that died is still a socket.
		if (command.includes('net").connect')) {
			return { code: listening ? 0 : 1, kind: "ran", stderr: "", stdout: "" };
		}
		if (command.includes("cat > ")) {
			return stdout("");
		}
		// One exchange: whatever arrived on stdin, then a snapshot reflecting it. The runner reads
		// lines in order, so a snapshot behind a prompt already shows the agent working, which is
		// what makes the delivery confirmation real rather than hopeful.
		if (command.includes("nc -U")) {
			const sent = (input ?? "").includes('"type":"prompt"');

			return stdout(
				`${JSON.stringify({
					approvals: [],
					messages: [],
					status: sent ? "working" : "idle",
					type: "snapshot",
				})}\n`,
			);
		}

		throw new Error(`unexpected ssh command: ${command}`);
	};

	return { ssh };
}

function database(): Database.Database {
	const db = openDatabase(":memory:");
	databases.push(db);

	return db;
}

// lostCloneResponse leaves a workspace holding a candidate VMID with no clone UPID, which is the
// state a controller crash between the two checkpoints produces.
async function lostCloneResponse(db: Database.Database): Promise<string> {
	const workspaceID = workspace(db);
	await runWorkspaceOperations(
		db,
		config(),
		async (url) => {
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "109" });
			}

			throw new Error("clone response lost");
		},
		SUBMITTED_AT,
	);

	return workspaceID;
}

function ownershipToken(db: Database.Database, workspaceID: string): string {
	return (
		db
			.prepare("SELECT ownership_token FROM workspaces WHERE id = ?")
			.get(workspaceID) as { ownership_token: string }
	).ownership_token;
}

// submitted leaves a workspace waiting on an accepted clone task recorded at a known time.
async function submitted(db: Database.Database): Promise<string> {
	const workspaceID = workspace(db);
	await runWorkspaceOperations(
		db,
		config(),
		async (url) => {
			if (url.endsWith("/cluster/nextid")) {
				return Response.json({ data: "109" });
			}

			return Response.json({ data: UPID });
		},
		SUBMITTED_AT,
	);

	return workspaceID;
}

function workspace(db: Database.Database): string {
	const created = createWorkspace(db, {
		idempotencyKey: "request-a",
		repository: "https://github.com/plainhq/plain.git",
		ref: "main",
	});
	if (created.kind !== "created") {
		throw new Error("expected workspace creation");
	}

	return created.workspace.id;
}

function workspaceStatus(db: Database.Database, workspaceID: string): string {
	return (
		db
			.prepare("SELECT status FROM workspaces WHERE id = ?")
			.get(workspaceID) as {
			status: string;
		}
	).status;
}

describe("runWorkspaceOperations giving up", () => {
	it("fails a provision that has been retrying past its deadline", async () => {
		const db = database();
		const workspaceID = workspace(db);

		// Stands in for a durable fault such as a revoked Proxmox token: the request never
		// succeeds, so no task is ever recorded and the per-task deadline never applies.
		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 401 }),
			new Date(Date.now() + 2 * 60 * 60 * 1000),
		);

		expect(result).toEqual({ processed: 1, status: "attempts_exhausted" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({
			error_code: "provision_attempts_exhausted",
			status: "failed",
		});
	});

	it("halts rather than fails an exhausted destroy", async () => {
		const db = database();
		const workspaceID = workspace(db);
		requestWorkspaceOperation(db, workspaceID, "destroy");

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 401 }),
			new Date(Date.now() + 2 * 60 * 60 * 1000),
		);

		// The desired state is still "destroyed" and the container may still exist, so teardown
		// stops for a human rather than claiming a terminal failure.
		expect(result).toEqual({ processed: 1, status: "attempts_exhausted" });
		expect(
			db
				.prepare("SELECT status, error_code FROM workspaces WHERE id = ?")
				.get(workspaceID),
		).toEqual({
			error_code: "destroy_attempts_exhausted",
			status: "destroying",
		});
	});

	it("leaves a young operation alone", async () => {
		const db = database();
		workspace(db);

		const result = await runWorkspaceOperations(
			db,
			config(),
			async () => new Response("", { status: 401 }),
			new Date(),
		);

		expect(result.status).not.toBe("attempts_exhausted");
	});
});

describe("workspace node", () => {
	it("addresses the node the container actually landed on", async () => {
		const db = database();
		const workspaceID = await destroyable(db);
		// The clone recorded node "nas"; pretend the controller is now configured for another.
		db.prepare("UPDATE workspaces SET node = 'other' WHERE id = ?").run(
			workspaceID,
		);

		const urls: string[] = [];
		await tick(db, async (url) => {
			urls.push(url);

			return Response.json({ data: { description: "nope" } });
		});

		expect(urls[0]).toContain("/nodes/other/lxc/109/config");
	});
});
