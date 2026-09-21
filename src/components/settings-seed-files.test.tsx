// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render as renderBare,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SeedFile } from "../domain/seed-file";

// The server boundary is the seam. The queries, the cache and the invalidation after a save are
// left real, because what is worth asserting is that a draft survives a switch.
const listSeedFiles = vi.fn();
const readSeedFile = vi.fn();
const saveWorkspaceSeedFile = vi.fn();
const deleteWorkspaceSeedFile = vi.fn();

vi.mock("../server/seed-files.functions", () => ({
	deleteWorkspaceSeedFile: (...args: unknown[]) =>
		deleteWorkspaceSeedFile(...args),
	listSeedFiles: (...args: unknown[]) => listSeedFiles(...args),
	readSeedFile: (...args: unknown[]) => readSeedFile(...args),
	saveWorkspaceSeedFile: (...args: unknown[]) => saveWorkspaceSeedFile(...args),
}));

const { SettingsSeedFiles } = await import("./settings-seed-files");

// Testing Library only registers its own afterEach with vitest globals enabled, which they are not.
afterEach(cleanup);

const VIMRC: SeedFile = {
	bytes: 1024,
	id: "a",
	path: ".vimrc",
	root: "home",
	updatedAt: "2026-09-01T10:00:00.000Z",
};

const SETTINGS: SeedFile = {
	bytes: 2048,
	id: "b",
	path: ".claude/settings.json",
	root: "home",
	updatedAt: "2026-09-01T10:00:00.000Z",
};

const BODIES: Record<string, string> = {
	a: "set number",
	b: '{ "model": "opus" }',
};

beforeEach(() => {
	vi.clearAllMocks();
	listSeedFiles.mockResolvedValue([VIMRC, SETTINGS]);
	readSeedFile.mockImplementation(({ data }: { data: { id: string } }) =>
		Promise.resolve({ content: BODIES[data.id] }),
	);
});

function render() {
	// `retry: false` so a rejected query fails the test instead of being retried past its timeout.
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	return renderBare(
		<QueryClientProvider client={client}>
			<SettingsSeedFiles />
		</QueryClientProvider>,
	);
}

function editor(): HTMLTextAreaElement {
	return screen.getByRole("textbox", {
		name: /vimrc|settings\.json|new seed file/i,
	}) as HTMLTextAreaElement;
}

describe("SettingsSeedFiles", () => {
	it("shows no editor until a file is chosen", async () => {
		// The pane is pinned, so something has to be in it before anything is selected. An empty
		// editor there would look like a file with nothing in it.
		render();

		expect(
			await screen.findByRole("button", { name: /\.vimrc/ }),
		).toBeDefined();
		expect(screen.getByText("Select a file, or add one.")).toBeDefined();
		expect(screen.queryByRole("textbox", { name: /vimrc/i })).toBeNull();
	});

	it("says so rather than showing an empty list", async () => {
		listSeedFiles.mockResolvedValue([]);
		render();

		expect(await screen.findByText("No seed files yet.")).toBeDefined();
	});

	it("opens the chosen file in the pane", async () => {
		render();

		await userEvent.click(
			await screen.findByRole("button", { name: /\.vimrc/ }),
		);

		await waitFor(() => expect(editor().value).toBe("set number"));
	});

	it("keeps an unsaved edit when another file is opened", async () => {
		// The reason the draft is held above the editor at all. Switching files is one click on
		// something that looks like navigation; without this it silently threw the edit away.
		render();

		await userEvent.click(
			await screen.findByRole("button", { name: /\.vimrc/ }),
		);
		await waitFor(() => expect(editor().value).toBe("set number"));
		await userEvent.type(editor(), "!");

		await userEvent.click(
			screen.getByRole("button", { name: /settings\.json/ }),
		);
		await waitFor(() => expect(editor().value).toBe('{ "model": "opus" }'));

		await userEvent.click(screen.getByRole("button", { name: /\.vimrc/ }));
		await waitFor(() => expect(editor().value).toBe("set number!"));
	});

	it("marks the rows still carrying an unsaved edit", async () => {
		render();

		await userEvent.click(
			await screen.findByRole("button", { name: /\.vimrc/ }),
		);
		await waitFor(() => expect(editor().value).toBe("set number"));
		await userEvent.type(editor(), "!");

		expect(screen.getByLabelText("unsaved changes")).toBeDefined();
	});

	it("drops the draft once it is saved", async () => {
		saveWorkspaceSeedFile.mockResolvedValue(VIMRC);
		render();

		await userEvent.click(
			await screen.findByRole("button", { name: /\.vimrc/ }),
		);
		await waitFor(() => expect(editor().value).toBe("set number"));
		await userEvent.type(editor(), "!");
		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(screen.queryByLabelText("unsaved changes")).toBeNull(),
		);
	});

	it("follows a newly added file onto its own row", async () => {
		// Saving the add gives the file an id for the first time. Landing on the row that just
		// appeared is what says the add worked; the pane closing would leave that to the list.
		const added: SeedFile = { ...SETTINGS, id: "c", path: ".bashrc" };
		saveWorkspaceSeedFile.mockResolvedValue(added);
		listSeedFiles.mockResolvedValue([VIMRC, SETTINGS]);
		BODIES.c = "export EDITOR=vim";
		render();

		await userEvent.click(
			await screen.findByRole("button", { name: /add file/i }),
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "Destination" }),
			".bashrc",
		);
		listSeedFiles.mockResolvedValue([VIMRC, SETTINGS, added]);
		await userEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(screen.getByRole("button", { name: /\.bashrc/ })).toBeDefined(),
		);
		expect(saveWorkspaceSeedFile).toHaveBeenCalledWith({
			data: { content: "", id: undefined, path: ".bashrc", root: "home" },
		});
	});

	it("refuses to save a destination that escapes its root", async () => {
		// The rule lives in readSeedPath; what is asserted here is that the pane says why rather
		// than letting the button be pressed and the server refuse it.
		render();

		await userEvent.click(
			await screen.findByRole("button", { name: /add file/i }),
		);
		await userEvent.type(
			screen.getByRole("textbox", { name: "Destination" }),
			"../etc/passwd",
		);

		expect(
			screen.getByText("a destination cannot step outside its root with .."),
		).toBeDefined();
		expect(
			screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
		).toBe(true);
	});

	it("clears the pane when the open file is removed", async () => {
		// The row it was showing is gone. Leaving the editor up would offer a Save against an id
		// the controller no longer has.
		deleteWorkspaceSeedFile.mockResolvedValue({ kind: "removed" });
		render();

		await userEvent.click(
			await screen.findByRole("button", { name: /\.vimrc/ }),
		);
		await waitFor(() => expect(editor().value).toBe("set number"));
		listSeedFiles.mockResolvedValue([SETTINGS]);
		await userEvent.click(screen.getByRole("button", { name: "Remove" }));

		await waitFor(() =>
			expect(screen.getByText("Select a file, or add one.")).toBeDefined(),
		);
	});
});
