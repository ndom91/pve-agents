import { useSuspenseQuery } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { settingsQuery } from "../lib/queries";
import { saveWorkspaceSettings } from "../server/settings.functions";
import { Button } from "./button";

// SettingsReaping is the policy for destroying workspaces nobody is using.
export function SettingsReaping(): ReactNode {
	// Suspense rather than a guard: the route's loader already ensured this key, so the data is
	// present and this does not need a loading branch it will never render.
	const { data: settings } = useSuspenseQuery(settingsQuery());
	const [enabled, setEnabled] = useState(settings.reapingEnabled);
	const [idle, setIdle] = useState(String(settings.reapIdleMinutes));
	const [maxAge, setMaxAge] = useState(String(settings.reapMaxAgeHours));
	const [failedAfter, setFailedAfter] = useState(
		String(settings.reapFailedAfterHours),
	);
	const [note, setNote] = useState("");
	const [saving, setSaving] = useState(false);

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
		<form className="settings-form" onSubmit={save}>
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
					workspace that was never given a task counts from when it was created.
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
				<span className="activity activity-blocked">blocked</span> badge on the
				fleet.
			</p>

			<Button disabled={saving} type="submit">
				{saving ? "Saving" : "Save"}
			</Button>
			{note === "" ? null : <p className="detail-note">{note}</p>}
		</form>
	);
}
