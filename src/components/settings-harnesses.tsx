import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
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
import { SectionHead } from "./section-head";
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
		<section className="settings-seed">
			<p>
				The agents a workspace can be launched on. Each carries its own
				credential, which is stored here and written into a workspace as it is
				provisioned. Rotating one takes effect on the next workspace.
			</p>

			<div className="seed-browser">
				<div className="seed-index">
					<SectionHead count={configured.length} label="Agents" />

					{configured.length === 0 ? (
						<p className="seed-empty">
							None yet. A workspace cannot be launched until there is one.
						</p>
					) : (
						<ul className="seed-list">
							{configured.map((harness) => (
								<li key={harness.id}>
									<button
										aria-pressed={harness.id === selected}
										className={
											harness.id === selected
												? "seed-row is-active"
												: "seed-row"
										}
										onClick={() => setSelected(harness.id)}
										type="button"
									>
										<span className="seed-path">
											<span className="seed-name">{harness.name}</span>
										</span>
										<span className="seed-size">
											{harness.enabled ? harness.kind : `${harness.kind} · off`}
										</span>
									</button>
								</li>
							))}
						</ul>
					)}

					<Button
						className="seed-add"
						onClick={() => setSelected(NEW)}
						variant="secondary"
					>
						<Plus aria-hidden size={12} strokeWidth={1.5} />
						<span>Add agent</span>
					</Button>
				</div>

				<div className="seed-pane">
					{selected === undefined ? (
						<p className="seed-blank">Select an agent, or add one.</p>
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
		</section>
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
	const [enabled, setEnabled] = useState(harness?.enabled ?? true);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);

	async function refresh() {
		// One call covers both: TanStack matches by prefix and the launchable key is
		// ["harnesses", "launchable"], nested inside this one.
		await client.invalidateQueries({ queryKey: workspaceKeys.harnesses() });
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

			<label className="settings-toggle">
				<input
					checked={enabled}
					onChange={(event) => setEnabled(event.target.checked)}
					type="checkbox"
				/>
				<span>Offer this agent when launching a workspace</span>
			</label>

			<div className="seed-actions">
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
