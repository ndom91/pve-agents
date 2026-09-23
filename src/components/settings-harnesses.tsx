import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";

import type { HarnessConfig } from "../domain/harness-config";
import {
	harnessesQuery,
	harnessKindsQuery,
	workspaceKeys,
} from "../lib/queries";
import {
	deleteWorkspaceHarness,
	saveWorkspaceHarness,
} from "../server/harnesses.functions";
import { Button } from "./button";
import { Select } from "./select";

// The sentinel for "adding one" in the same slot the ids occupy, so the editor has a single
// selection to key off rather than a selection and a separate "am I adding" flag.
const NEW = "new";

// SettingsHarnesses is where an operator sets up the agents workspaces can run on.
//
// A list beside an editor, like the seed files tab: the same shape because it is the same job --
// several configured things, one open at a time.
export function SettingsHarnesses(): ReactNode {
	const { data: configured } = useSuspenseQuery(harnessesQuery());
	const { data: kinds } = useSuspenseQuery(harnessKindsQuery());
	const [selected, setSelected] = useState<string | undefined>(undefined);

	const editing = configured.find((harness) => harness.id === selected);

	return (
		<div className="seed-layout">
			<div className="seed-index">
				{configured.length === 0 ? (
					<p className="seed-empty">
						No agents configured. A workspace cannot be launched until there is
						one.
					</p>
				) : (
					<ul className="seed-list">
						{configured.map((harness) => (
							<li key={harness.id}>
								<button
									className={`seed-entry${harness.id === selected ? " is-open" : ""}`}
									onClick={() => setSelected(harness.id)}
									type="button"
								>
									<span className="seed-entry-path">{harness.name}</span>
									<span className="seed-entry-meta">
										{harness.kind}
										{harness.enabled ? "" : " · disabled"}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}

				<Button
					onClick={() => setSelected(NEW)}
					type="button"
					variant="secondary"
				>
					Add an agent
				</Button>
			</div>

			<div className="seed-editor">
				{selected === undefined ? (
					<p className="seed-empty">
						Pick an agent to edit, or add one. Each carries its own credential,
						and a workspace is launched on one of them.
					</p>
				) : (
					<HarnessForm
						// Remounted per selection, so the fields come from the harness being
						// edited rather than from whichever was open before it.
						key={selected}
						harness={editing}
						kinds={kinds}
						onDone={() => setSelected(undefined)}
					/>
				)}
			</div>
		</div>
	);
}

function HarnessForm({
	harness,
	kinds,
	onDone,
}: {
	harness?: HarnessConfig;
	kinds: string[];
	onDone: () => void;
}): ReactNode {
	const client = useQueryClient();
	const kindId = useId();
	const [name, setName] = useState(harness?.name ?? "");
	const [kind, setKind] = useState(harness?.kind ?? kinds[0] ?? "");
	const [credential, setCredential] = useState("");
	const [model, setModel] = useState(harness?.model ?? "");
	const [permissionMode, setPermissionMode] = useState(
		harness?.permissionMode ?? "auto",
	);
	const [enabled, setEnabled] = useState(harness?.enabled ?? true);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);

	async function refresh() {
		await client.invalidateQueries({ queryKey: workspaceKeys.harnesses() });
		await client.invalidateQueries({ queryKey: workspaceKeys.launchable() });
	}

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setBusy(true);
		setNote("");
		try {
			await saveWorkspaceHarness({
				data: {
					// Sent only when typed. Blank means "keep the stored one", which is what stops
					// renaming an agent from blanking its credential.
					credential: credential.trim() === "" ? undefined : credential.trim(),
					enabled,
					id: harness?.id,
					kind,
					model: model.trim() === "" ? undefined : model.trim(),
					name: name.trim(),
					permissionMode: permissionMode.trim(),
				},
			});
			await refresh();
			onDone();
		} catch (cause) {
			setNote(cause instanceof Error ? cause.message : "could not save");
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		if (harness === undefined) {
			return;
		}
		setBusy(true);
		try {
			await deleteWorkspaceHarness({ data: { id: harness.id } });
			await refresh();
			onDone();
		} catch (cause) {
			setNote(cause instanceof Error ? cause.message : "could not delete");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="settings-form" onSubmit={save}>
			<label className="settings-field">
				<span>Name</span>
				<input
					onChange={(event) => setName(event.target.value)}
					placeholder="Claude (subscription)"
					value={name}
				/>
			</label>

			<div className="settings-field">
				<label htmlFor={kindId}>
					<span>Agent</span>
				</label>
				<Select
					id={kindId}
					onChange={setKind}
					options={kinds.map((option) => ({ label: option, value: option }))}
					value={kind}
				/>
			</div>

			<label className="settings-field">
				<span>Credential</span>
				<input
					onChange={(event) => setCredential(event.target.value)}
					placeholder={
						harness === undefined
							? "Pasted once, never shown again"
							: "Stored. Type to replace it."
					}
					type="password"
					value={credential}
				/>
			</label>

			<label className="settings-field">
				<span>Model</span>
				<input
					onChange={(event) => setModel(event.target.value)}
					placeholder="Optional, e.g. openai/gpt-5.6-luna-fast"
					value={model}
				/>
			</label>

			<label className="settings-field">
				<span>Permissions</span>
				<input
					onChange={(event) => setPermissionMode(event.target.value)}
					placeholder="auto"
					value={permissionMode}
				/>
			</label>

			<label className="settings-toggle">
				<input
					checked={enabled}
					onChange={(event) => setEnabled(event.target.checked)}
					type="checkbox"
				/>
				<span>Offer this agent when launching a workspace</span>
			</label>

			<div className="settings-actions">
				<Button disabled={busy} type="submit">
					{busy ? "Saving" : "Save"}
				</Button>
				{harness === undefined ? undefined : (
					<Button
						disabled={busy}
						onClick={() => void remove()}
						type="button"
						variant="danger"
					>
						Delete
					</Button>
				)}
				{note === "" ? undefined : (
					<span className="settings-note">{note}</span>
				)}
			</div>
		</form>
	);
}
