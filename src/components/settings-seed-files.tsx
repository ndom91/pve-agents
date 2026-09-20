import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";

import {
	MAX_SEED_BYTES,
	readSeedPath,
	resolveSeedPath,
	SEED_ROOTS,
	type SeedRoot,
} from "../domain/seed-file";
import { seedFilesQuery, workspaceKeys } from "../lib/queries";
import {
	deleteWorkspaceSeedFile,
	saveWorkspaceSeedFile,
} from "../server/seed-files.functions";
import { Button } from "./button";

// SettingsSeedFiles is what every new workspace is seeded with.
export function SettingsSeedFiles(): ReactNode {
	const queryClient = useQueryClient();
	const { data: files = [] } = useQuery(seedFilesQuery());
	const [root, setRoot] = useState<SeedRoot>("home");
	const [path, setPath] = useState("");
	const [content, setContent] = useState<string | undefined>(undefined);
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	// Held so the input can be cleared after a save. A file input's value cannot be set from state,
	// so this is the one place a ref is the mechanism rather than a shortcut.
	const picker = useRef<HTMLInputElement>(null);

	const destination = readSeedPath(root, path);
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: workspaceKeys.seedFiles() });

	// Read in the browser and posted as a string, so nothing here handles multipart. That is the
	// reason the feature is text-only: a binary file would mean base64 on the wire and in the
	// database, for a case nobody has asked for.
	async function choose(file: File | undefined): Promise<void> {
		setNote("");
		if (file === undefined) {
			setContent(undefined);

			return;
		}
		if (file.size > MAX_SEED_BYTES) {
			setContent(undefined);
			setNote(`${file.name} is larger than ${MAX_SEED_BYTES / 1024} kB.`);

			return;
		}

		setContent(await file.text());
		// A destination the operator can accept rather than one they have to invent. Only when
		// they have not already typed one.
		if (path.trim() === "") {
			setPath(file.name);
		}
	}

	async function add(): Promise<void> {
		if (content === undefined || destination.kind === "invalid") {
			return;
		}

		setBusy(true);
		setNote("");
		try {
			await saveWorkspaceSeedFile({
				data: { content, path: destination.path, root },
			});
			await refresh();
			setPath("");
			setContent(undefined);
			if (picker.current !== null) {
				picker.current.value = "";
			}
			setNote("Saved. Applied to workspaces created from now on.");
		} catch (cause) {
			setNote(cause instanceof Error ? cause.message : "could not save");
		} finally {
			setBusy(false);
		}
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

			{files.length === 0 ? (
				<p className="detail-note">
					No seed files. Workspaces get whatever their repository carries.
				</p>
			) : (
				<ul className="seed-list">
					{files.map((file) => (
						<li key={file.id}>
							<code>{resolveSeedPath(file.root, file.path)}</code>
							<span>{Math.max(1, Math.round(file.bytes / 1024))} kB</span>
							<Button
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									setNote("");
									try {
										await deleteWorkspaceSeedFile({ data: { id: file.id } });
										await refresh();
									} finally {
										setBusy(false);
									}
								}}
								variant="tertiary"
							>
								Remove
							</Button>
						</li>
					))}
				</ul>
			)}

			<div className="seed-add">
				<label className="settings-field">
					<span>Root</span>
					<select
						onChange={(event) => setRoot(event.target.value as SeedRoot)}
						value={root}
					>
						{SEED_ROOTS.map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</select>
				</label>

				<label className="settings-field">
					<span>Destination</span>
					<input
						onChange={(event) => setPath(event.target.value)}
						placeholder=".claude/settings.json"
						type="text"
						value={path}
					/>
				</label>

				<label className="settings-field">
					<span>File</span>
					<input
						onChange={(event) => void choose(event.target.files?.[0])}
						ref={picker}
						type="file"
					/>
				</label>
			</div>

			{/* Where it lands, before saving rather than after a provision. $HOME is shown
			    symbolically because the container is the only thing that can resolve it. */}
			{path.trim() === "" ? null : (
				<p className="detail-note">
					{destination.kind === "invalid"
						? destination.message
						: `→ ${resolveSeedPath(root, destination.path)}`}
				</p>
			)}

			<Button
				disabled={
					busy || content === undefined || destination.kind === "invalid"
				}
				onClick={() => void add()}
			>
				{busy ? "Saving" : "Add file"}
			</Button>
			{note === "" ? null : <p className="detail-note">{note}</p>}
		</section>
	);
}
