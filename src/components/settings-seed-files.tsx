import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";

import {
	MAX_SEED_BYTES,
	readSeedPath,
	resolveSeedPath,
	SEED_ROOTS,
	type SeedFile,
	type SeedRoot,
} from "../domain/seed-file";
import { languageOfPath } from "../lib/highlight";
import { seedFileQuery, seedFilesQuery, workspaceKeys } from "../lib/queries";
import {
	deleteWorkspaceSeedFile,
	saveWorkspaceSeedFile,
} from "../server/seed-files.functions";
import { Button } from "./button";
import { CodeEditor } from "./code-editor";
import { SectionHead } from "./section-head";
import { type Option, Select } from "./select";

// The label is the root's own name: "home", "repo" and "absolute" say what they mean and a prettier
// caption would only be a second word for the same thing.
const ROOT_OPTIONS: Option<SeedRoot>[] = SEED_ROOTS.map((root) => ({
	label: root,
	value: root,
}));

// NEW_FILE is the selection standing for the file being added.
//
// A sentinel rather than a second `adding` boolean: the pane shows exactly one thing, and two
// pieces of state that must never both be set is the shape that eventually sets both.
const NEW_FILE = "new";

// SettingsSeedFiles is what every new workspace is seeded with.
//
// An index on the left and one pinned editor on the right, the same column-plus-panel shape as
// the workspace page.
export function SettingsSeedFiles(): ReactNode {
	const { data: files = [] } = useQuery(seedFilesQuery());
	const [selected, setSelected] = useState<string | undefined>(undefined);
	// Edited-but-unsaved bodies, keyed by file id or NEW_FILE.
	//
	// Held here rather than inside the editor, which is what makes switching files safe: one click
	// on something that looks like navigation would otherwise throw the edit away silently.
	const [drafts, setDrafts] = useState<Record<string, string>>({});

	function forget(key: string): void {
		setDrafts(({ [key]: _gone, ...rest }) => rest);
	}

	return (
		<section className="settings-seed">
			<p>
				Text files written into every workspace as it is provisioned, before the
				agent starts. Applied to new workspaces only. Up to{" "}
				{MAX_SEED_BYTES / 1024} kB each.
			</p>

			<div className="seed-browser">
				<div className="seed-index">
					<SectionHead count={files.length} label="Seed files" />

					{files.length === 0 ? (
						<p className="seed-empty">No seed files yet.</p>
					) : (
						<ul className="seed-list">
							{files.map((file) => (
								<SeedIndexRow
									edited={drafts[file.id] !== undefined}
									file={file}
									key={file.id}
									onSelect={() => setSelected(file.id)}
									selected={selected === file.id}
								/>
							))}
						</ul>
					)}

					<Button
						className="seed-add"
						onClick={() => setSelected(NEW_FILE)}
						variant="secondary"
					>
						<Plus aria-hidden size={12} strokeWidth={1.5} />
						<span>Add file</span>
					</Button>
				</div>

				<div className="seed-pane">
					{selected === undefined ? (
						<p className="seed-blank">Select a file, or add one.</p>
					) : (
						<SeedForm
							draft={drafts[selected]}
							file={files.find((file) => file.id === selected)}
							// Remounts per selection, so root, destination and note belong to the
							// file on screen. The body does not reset with it; that is a prop.
							key={selected}
							onDraft={(content) =>
								setDrafts((current) => ({ ...current, [selected]: content }))
							}
							onRemoved={() => {
								forget(selected);
								setSelected(undefined);
							}}
							onSaved={(saved) => {
								forget(selected);
								// Follows the file. Saving a new one gives it an id for the first
								// time, and landing on the row that just appeared says it worked.
								setSelected(saved.id);
							}}
						/>
					)}
				</div>
			</div>
		</section>
	);
}

// SeedIndexRow is one file in the index.
//
// Directory and name are separate spans so the front can be dimmed: six destinations that all
// begin `$HOME/.claude/` differ only at the end.
function SeedIndexRow({
	edited,
	file,
	onSelect,
	selected,
}: {
	edited: boolean;
	file: SeedFile;
	onSelect: () => void;
	selected: boolean;
}): ReactNode {
	const resolved = resolveSeedPath(file.root, file.path);
	const cut = resolved.lastIndexOf("/") + 1;

	return (
		<li>
			<button
				// Not `aria-selected`, which needs a listbox around it, and not a link, which this
				// is not.
				aria-pressed={selected}
				className={selected ? "seed-row is-active" : "seed-row"}
				onClick={onSelect}
				type="button"
			>
				<span className="seed-path">
					<span className="seed-dir">{resolved.slice(0, cut)}</span>
					<span className="seed-name">{resolved.slice(cut)}</span>
				</span>
				{edited ? (
					<span aria-label="unsaved changes" className="seed-dot" role="img">
						•
					</span>
				) : null}
				<span className="seed-size">
					{Math.max(1, Math.round(file.bytes / 1024))} kB
				</span>
			</button>
		</li>
	);
}

// SeedForm edits one file: where it goes, and what is in it.
function SeedForm({
	draft,
	file,
	onDraft,
	onRemoved,
	onSaved,
}: {
	draft?: string;
	file?: SeedFile;
	onDraft: (content: string) => void;
	onRemoved: () => void;
	onSaved: (saved: SeedFile) => void;
}): ReactNode {
	const queryClient = useQueryClient();
	// Only for a file that exists. `enabled` rather than a branch, so the new-file pane asks for
	// nothing at all.
	const { data: stored } = useQuery({
		...seedFileQuery(file?.id ?? ""),
		enabled: file !== undefined,
	});

	const [root, setRoot] = useState<SeedRoot>(file?.root ?? "home");
	const [path, setPath] = useState(file?.path ?? "");
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	// A file input cannot be driven from state, so clearing it after a load needs the node itself.
	const picker = useRef<HTMLInputElement>(null);
	const rootId = useId();

	// The stored body until something is typed. Not copied into state on load, because state
	// initialised from a query keeps whatever arrived first and the fetch resolves after the mount.
	const content = draft ?? stored?.content ?? "";
	const destination = readSeedPath(root, path);
	const loading = file !== undefined && stored === undefined;

	async function load(chosen: File | undefined): Promise<void> {
		setNote("");
		if (chosen === undefined) {
			return;
		}
		if (chosen.size > MAX_SEED_BYTES) {
			setNote(`${chosen.name} is larger than ${MAX_SEED_BYTES / 1024} kB.`);

			return;
		}

		// Into the editor rather than straight to the server, so it can be read and corrected
		// before it is saved. This is what makes a pasted file and a chosen one the same thing.
		onDraft(await chosen.text());
		if (path.trim() === "") {
			setPath(chosen.name);
		}
		if (picker.current !== null) {
			picker.current.value = "";
		}
	}

	async function save(): Promise<void> {
		if (destination.kind === "invalid") {
			return;
		}

		setBusy(true);
		setNote("");
		try {
			const saved = await saveWorkspaceSeedFile({
				data: { content, id: file?.id, path: destination.path, root },
			});
			// Invalidating the list key also reaches the open file's body, because the row keys
			// are nested under it.
			await queryClient.invalidateQueries({
				queryKey: workspaceKeys.seedFiles(),
			});
			onSaved(saved);
			setNote("Saved. Applied to workspaces created from now on.");
		} catch (cause) {
			setNote(cause instanceof Error ? cause.message : "could not save");
		} finally {
			setBusy(false);
		}
	}

	async function remove(): Promise<void> {
		if (file === undefined) {
			return;
		}

		setBusy(true);
		try {
			await deleteWorkspaceSeedFile({ data: { id: file.id } });
			await queryClient.invalidateQueries({
				queryKey: workspaceKeys.seedFiles(),
			});
			onRemoved();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="seed-form">
			<div className="seed-where">
				<div className="settings-field">
					<label htmlFor={rootId}>
						<span>Root</span>
					</label>
					<Select
						id={rootId}
						onChange={setRoot}
						options={ROOT_OPTIONS}
						value={root}
					/>
				</div>

				<label className="settings-field seed-destination">
					<span>Destination</span>
					<input
						onChange={(event) => setPath(event.target.value)}
						placeholder=".claude/settings.json"
						type="text"
						value={path}
					/>
				</label>

				{/* A button over a hidden input, because the browser's own file control carries its
				    own chrome and sat beside two fields that carry this application's. */}
				<Button onClick={() => picker.current?.click()} variant="secondary">
					Upload
				</Button>
				<input
					className="seed-picker"
					onChange={(event) => void load(event.target.files?.[0])}
					ref={picker}
					type="file"
				/>
			</div>

			{loading ? (
				<p className="detail-note">Reading the file.</p>
			) : (
				<CodeEditor
					label={path === "" ? "New seed file" : path}
					// From the destination, so a settings.json is JSON and a CLAUDE.md is markdown
					// without anybody choosing a language.
					lang={languageOfPath(path)}
					onChange={onDraft}
					// Attached to the text it describes, rather than floating above the fields as
					// a line of its own.
					status={
						<>
							<span
								className={
									destination.kind === "valid" ? "is-path" : "is-wrong"
								}
							>
								{destination.kind === "invalid"
									? destination.message
									: resolveSeedPath(root, destination.path)}
							</span>
							<span>{languageOfPath(path)}</span>
						</>
					}
					value={content}
				/>
			)}

			<div className="seed-actions">
				<Button
					disabled={busy || loading || destination.kind === "invalid"}
					onClick={() => void save()}
				>
					{busy ? "Saving" : "Save"}
				</Button>
				{file === undefined ? null : (
					// Explicit rather than revealed on hover of the index row: it is the only
					// irreversible control here, and destroy set the rule that those stay visible.
					<Button
						disabled={busy}
						onClick={() => void remove()}
						variant="danger"
					>
						Remove
					</Button>
				)}
			</div>
			{note === "" ? null : <p className="detail-note">{note}</p>}
		</div>
	);
}
