import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "../components/button";
import { settingsQuery } from "../lib/queries";
import {
	destroyOrphan,
	type OrphanRemoval,
	scanOrphans,
} from "../server/orphan.functions";
import { saveWorkspaceSettings } from "../server/settings.functions";

export const Route = createFileRoute("/_dashboard/settings")({
	component: Settings,
	// Auth is handled once by the _dashboard layout, so it is not repeated here.
	loader: ({ context }) => context.queryClient.ensureQueryData(settingsQuery()),
});

function Settings() {
	// Suspense rather than a guard: the loader already ensured this key, so the data is present
	// and the component does not need a loading branch it will never render.
	const { data: settings } = useSuspenseQuery(settingsQuery());
	const [enabled, setEnabled] = useState(settings.reapingEnabled);
	const [idle, setIdle] = useState(String(settings.reapIdleMinutes));
	const [maxAge, setMaxAge] = useState(String(settings.reapMaxAgeHours));
	const [failedAfter, setFailedAfter] = useState(
		String(settings.reapFailedAfterHours),
	);
	const [note, setNote] = useState("");
	const [saving, setSaving] = useState(false);
	const [scan, setScan] = useState<Awaited<
		ReturnType<typeof scanOrphans>
	> | null>(null);
	const [scanning, setScanning] = useState(false);
	const [maintenanceNote, setMaintenanceNote] = useState("");

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setSaving(true);
		setNote("");
		try {
			await saveWorkspaceSettings({
				data: {
					reapFailedAfterHours: Number(failedAfter),
					reapIdleMinutes: Number(idle),
					reapMaxAgeHours: Number(maxAge),
					reapingEnabled: enabled,
				},
			});
			setNote("Saved. In effect from the next pass.");
		} catch (cause) {
			setNote(cause instanceof Error ? cause.message : "could not save");
		} finally {
			setSaving(false);
		}
	}

	return (
		<main className="dashboard-main dashboard-main-wide">
			<header>
				<h1>Settings</h1>
				<p className="workspace-purpose">
					Saved to the controller database and read on every pass, so a change
					applies without a restart.
				</p>
			</header>

			<form className="settings-form" onSubmit={save}>
				<h2>Reaping</h2>

				<label className="settings-toggle">
					<input
						checked={enabled}
						onChange={(event) => setEnabled(event.target.checked)}
						type="checkbox"
					/>
					<span>Destroy workspaces automatically</span>
				</label>

				<label className="settings-field">
					<span>Idle timeout</span>
					<input
						min={5}
						max={10080}
						onChange={(event) => setIdle(event.target.value)}
						type="number"
						value={idle}
					/>
					<small>
						Minutes an agent may do nothing before its workspace is destroyed. A
						workspace that was never given a task counts from when it was
						created.
					</small>
				</label>

				<label className="settings-field">
					<span>Maximum age</span>
					<input
						min={1}
						max={720}
						onChange={(event) => setMaxAge(event.target.value)}
						type="number"
						value={maxAge}
					/>
					<small>
						Hours a workspace may exist, whatever it is doing. A hard cap.
					</small>
				</label>

				<label className="settings-field">
					<span>Failed grace period</span>
					<input
						min={1}
						max={720}
						onChange={(event) => setFailedAfter(event.target.value)}
						type="number"
						value={failedAfter}
					/>
					<small>
						Hours a failed workspace keeps its container before it is destroyed.
						Long enough to log in and see what went wrong; without this, the
						container leaks forever.
					</small>
				</label>

				<p className="settings-caveat">
					An agent waiting at a question is exempt from both rules, so that
					answering it later cannot lose its work. That does mean a question
					nobody answers keeps its container running indefinitely. Watch for the{" "}
					<span className="activity activity-blocked">blocked</span> badge on
					the fleet.
				</p>

				<Button disabled={saving} type="submit">
					{saving ? "Saving" : "Save"}
				</Button>
				{note === "" ? null : <p className="detail-note">{note}</p>}
			</form>

			<section className="settings-maintenance">
				<h2>Orphaned containers</h2>
				<p>
					Containers this controller created and no longer has a record of. The
					scan runs only when asked, never on a timer: a restored or lost
					database would make every live workspace look orphaned, and anything
					automatic would then destroy the fleet.
				</p>

				<Button
					disabled={scanning}
					onClick={async () => {
						setScanning(true);
						setMaintenanceNote("");
						try {
							setScan(await scanOrphans());
						} catch {
							setMaintenanceNote("could not reach the controller");
						} finally {
							setScanning(false);
						}
					}}
				>
					{scanning ? "Scanning" : "Scan for orphans"}
				</Button>

				{scan === null ? null : scan.kind === "failed" ? (
					<p className="detail-note">{scan.message}</p>
				) : (
					<div className="settings-orphans">
						{scan.orphans.length === 0 ? (
							<p className="detail-note">Nothing orphaned.</p>
						) : (
							<ul>
								{scan.orphans.map((orphan) => (
									<li key={orphan.vmid}>
										<span>
											{orphan.vmid} {orphan.hostname ?? ""}
										</span>
										<Button
											onClick={async () => {
												setMaintenanceNote("");
												const removed: OrphanRemoval = await destroyOrphan({
													data: { vmid: orphan.vmid },
												});
												setMaintenanceNote(
													removed.kind === "removed"
														? `${orphan.vmid} destroyed`
														: removed.message,
												);
												setScan(await scanOrphans());
											}}
										>
											Destroy
										</Button>
									</li>
								))}
							</ul>
						)}
						{scan.unreadable.length === 0 ? null : (
							<p className="detail-note">
								Could not read {scan.unreadable.join(", ")}, so those were not
								judged either way.
							</p>
						)}
					</div>
				)}
				{maintenanceNote === "" ? null : (
					<p className="detail-note">{maintenanceNote}</p>
				)}
			</section>
		</main>
	);
}
