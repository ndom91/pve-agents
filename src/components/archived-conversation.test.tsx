// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// The one server function this view reaches, mocked at that boundary. What is under test is that a
// saved conversation reads as the live one did, which only the rendered page can show.
let saved: { harness: string; messagesJson: string } | null = null;

vi.mock("../server/agent.functions", () => ({
	workspaceTranscript: async () => saved,
}));

const { ArchivedConversation } = await import("./archived-conversation");
const { TooltipProvider } = await import("./tooltip");

afterEach(cleanup);

function view() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});

	return render(
		<QueryClientProvider client={client}>
			<TooltipProvider>
				<ArchivedConversation workspaceId="w1" />
			</TooltipProvider>
		</QueryClientProvider>,
	);
}

describe("a destroyed workspace's conversation", () => {
	it("renders the saved messages through the harness that produced them", async () => {
		saved = {
			harness: "claude-code",
			messagesJson: JSON.stringify([
				{
					message: {
						content: [{ text: "The build is fixed.", type: "text" }],
						role: "assistant",
					},
					type: "assistant",
				},
			]),
		};
		view();

		expect(await screen.findByText("The build is fixed.")).toBeTruthy();
		// The live feed's invitation to start talking would be a lie here: nobody can.
		expect(screen.queryByText("Start a conversation")).toBeNull();
	});

	it("says plainly when no conversation was kept", async () => {
		// Every workspace destroyed before this shipped, and any whose agent did not answer on the
		// way out. An empty feed would read as an agent that never said anything.
		saved = null;
		view();

		expect(
			await screen.findByText("No conversation was kept for this workspace."),
		).toBeTruthy();
	});
});
