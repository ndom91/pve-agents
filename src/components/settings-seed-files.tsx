import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
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
import { type Option, Select } from "./select";

// The label is the root's own name: "home", "repo" and "absolute" say what they mean and a prettier
// caption would only be a second word for the same thing.
const ROOT_OPTIONS: Option<SeedRoot>[] = SEED_ROOTS.map((root) => ({
	label: root,
	value: root,
}));

// SettingsSeedFiles is what every new workspace is seeded with.
//
// A list of rows that unfold, the same gesture as the diff accordion, because the thing an operator
// wants here is the same: see what is in one of several files without leaving the others. Adding a
// file is that row with nothing in it, which is what removes the separate add-form the first
// version had -- and with it the reason uploading and pasting were two different paths.
export function SettingsSeedFiles(): ReactNode {
	const { data: files = [] } = useQuery(seedFilesQuery());
	// Which rows are unfolded. Several at once, like the diff accordion: comparing two seeded
	// files is a real reason to be here.
	const [open, setOpen] = useState<string[]>([]);

	function toggle(id: string): void {
		setOpen((current) =>
			current.includes(id)
				? current.filter((candidate) => candidate !== id)
				: [...current, id],
		);
	}

	return (
		<section className="settings-seed">
			<p>
				Text files written into every workspace as it is provisioned, before the
				agent starts. Up to {MAX_SEED_BYTES / 1024} kB each.
			</p>
			<p className="settings-caveat">
				Applied to new workspaces only. Nothing already running changes, because
				an agent reads its settings once when its session begins and a file that
				arrives afterwards would not be read until the container was rebuilt.
			</p>

			<ol className="seed-list">
				{files.map((file) => (
					<SeedRow
						file={file}
						key={file.id}
						onToggle={() => toggle(file.id)}
						open={open.includes(file.id)}
					/>
				))}
				<SeedRow
					onToggle={() => toggle("new")}
					open={open.includes("new")}
					// Closed again once saved, so the row is ready for the next one rather than
					// still holding the last file's text.
					onSaved={() => toggle("new")}
				/>
			</ol>
		</section>
	);
}

// SeedRow is one file, or the row that makes a new one.
//
// The editor is mounted only while the row is open, which is what makes the body fetch lazy: a
// page of twenty files costs twenty sizes until somebody opens one.
function SeedRow({
	file,
	onSaved,
	onToggle,
	open,
}: {
	file?: SeedFile;
	onSaved?: () => void;
	onToggle: () => void;
	open: boolean;
}): ReactNode {
	return (
		<li className="seed-entry">
			<button
				aria-expanded={open}
				className={file === undefined ? "seed-row is-new" : "seed-row"}
				onClick={onToggle}
				type="button"
			>
				<ChevronRight aria-hidden className="seed-caret" size={12} />
				<span className="seed-path">
					{file === undefined
						? "Add a file"
						: resolveSeedPath(file.root, file.path)}
				</span>
				{file === undefined ? null : (
					<span className="seed-size">
						{Math.max(1, Math.round(file.bytes / 1024))} kB
					</span>
				)}
			</button>
			{open ? <SeedForm file={file} onSaved={onSaved} /> : null}
		</li>
	);
}

// SeedForm edits one file: where it goes, and what is in it.
function SeedForm({
	file,
	onSaved,
}: {
	file?: SeedFile;
	onSaved?: () => void;
}): ReactNode {
	const queryClient = useQueryClient();
	// Only for a file that exists. `enabled` rather than a branch, so the new-file row asks for
	// nothing at all.
	const { data: stored } = useQuery({
		...seedFileQuery(file?.id ?? ""),
		enabled: file !== undefined,
	});

	const [root, setRoot] = useState<SeedRoot>(file?.root ?? "home");
	const [path, setPath] = useState(file?.path ?? "");
	const [draft, setDraft] = useState<string | undefined>(undefined);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	// A file input cannot be driven from state, so clearing it after a load needs the node itself.
	const picker = useRef<HTMLInputElement>(null);
	const rootId = useId();

	// The stored body until something is typed. Not seeded into state on load, because state
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
		setDraft(await chosen.text());
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
			await saveWorkspaceSeedFile({
				data: { content, id: file?.id, path: destination.path, root },
			});
			// Invalidating the list key also reaches every open row's body, because the row keys
			// are nested under it.
			await queryClient.invalidateQueries({
				queryKey: workspaceKeys.seedFiles(),
			});
			setDraft(undefined);
			onSaved?.();
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
					onChange={setDraft}
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
					<Button
						disabled={busy}
						onClick={() => void remove()}
						variant="tertiary"
					>
						Remove
					</Button>
				)}
			</div>
			{note === "" ? null : <p className="detail-note">{note}</p>}
		</div>
	);
}
