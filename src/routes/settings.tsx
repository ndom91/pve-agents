import {
	createFileRoute,
	Link,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { useState } from "react";

import { sessionState } from "../server/session.functions";
import {
	saveWorkspaceSettings,
	workspaceSettings,
} from "../server/settings.functions";

export const Route = createFileRoute("/settings")({
	beforeLoad: async () => {
		const state = await sessionState();
		if (state.required && !state.signedIn) {
			throw redirect({ to: "/login" });
		}
	},
	component: Settings,
	loader: async () => workspaceSettings(),
});

function Settings() {
	const settings = Route.useLoaderData();
	const router = useRouter();
	const [enabled, setEnabled] = useState(settings.reapingEnabled);
	const [idle, setIdle] = useState(String(settings.reapIdleMinutes));
	const [maxAge, setMaxAge] = useState(String(settings.reapMaxAgeHours));
	const [note, setNote] = useState("");
	const [saving, setSaving] = useState(false);

	async function save(event: React.FormEvent) {
		event.preventDefault();
		setSaving(true);
		setNote("");
		try {
			await saveWorkspaceSettings({
				data: {
					reapIdleMinutes: Number(idle),
					reapMaxAgeHours: Number(maxAge),
					reapingEnabled: enabled,
				},
			});
			setNote("Saved. In effect from the next pass.");
			router.invalidate();
		} catch (cause) {
			setNote(cause instanceof Error ? cause.message : "could not save");
		} finally {
			setSaving(false);
		}
	}

	return (
		<main className="detail">
			<nav>
				<Link to="/">Back to fleet</Link>
			</nav>

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

				<p className="settings-caveat">
					An agent waiting at a question is exempt from both rules, so that
					answering it later cannot lose its work. That does mean a question
					nobody answers keeps its container running indefinitely. Watch for the{" "}
					<span className="activity activity-blocked">blocked</span> badge on
					the fleet.
				</p>

				<button disabled={saving} type="submit">
					{saving ? "Saving" : "Save"}
				</button>
				{note === "" ? null : <p className="detail-note">{note}</p>}
			</form>
		</main>
	);
}
