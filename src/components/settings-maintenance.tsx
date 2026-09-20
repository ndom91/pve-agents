import { type ReactNode, useState } from "react";

import {
	destroyOrphan,
	type OrphanRemoval,
	scanOrphans,
} from "../server/orphan.functions";
import { Button } from "./button";

// SettingsMaintenance finds containers this controller created and no longer has a record of.
export function SettingsMaintenance(): ReactNode {
	const [scan, setScan] = useState<Awaited<
		ReturnType<typeof scanOrphans>
	> | null>(null);
	const [scanning, setScanning] = useState(false);
	const [note, setNote] = useState("");

	return (
		<section className="settings-maintenance">
			<p>
				Containers this controller created and no longer has a record of. The
				scan runs only when asked, never on a timer: a restored or lost database
				would make every live workspace look orphaned, and anything automatic
				would then destroy the fleet.
			</p>

			<Button
				disabled={scanning}
				onClick={async () => {
					setScanning(true);
					setNote("");
					try {
						setScan(await scanOrphans());
					} catch {
						setNote("could not reach the controller");
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
											setNote("");
											const removed: OrphanRemoval = await destroyOrphan({
												data: { vmid: orphan.vmid },
											});
											setNote(
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
			{note === "" ? null : <p className="detail-note">{note}</p>}
		</section>
	);
}
