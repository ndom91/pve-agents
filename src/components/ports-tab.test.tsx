// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ListeningPort } from "../domain/port";

// The three server functions this tab reaches, mocked at that boundary. What is under test is the
// control each row offers, which is the part a person actually operates and the part no unit test
// of the parser can see.
type View =
  | { host: string; ip: string; kind: "listed"; ports: PortRow[] }
  | { kind: "unavailable"; message: string };
type PortRow = ListeningPort & { forwarded?: number };

function listed(...ports: PortRow[]): View {
  return { host: "10.0.3.50", ip: "10.0.3.100", kind: "listed", ports };
}

let view: View = listed();
const forwardPort = vi.fn(
  async (
    _input: unknown,
  ): Promise<{ allocated: number; kind: "forwarded" }> => ({
    allocated: 20_000,
    kind: "forwarded",
  }),
);
const stopPort = vi.fn(async (_input: unknown) => ({ stopped: true }));

vi.mock("../server/agent.functions", () => ({
  forwardPort: (input: unknown) => forwardPort(input),
  stopPort: (input: unknown) => stopPort(input),
  workspacePorts: async () => view,
}));

const { PortsTab } = await import("./ports-tab");
const { TooltipProvider } = await import("./tooltip");

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

function listener(over: Partial<PortRow> = {}): PortRow {
  return {
    address: "0.0.0.0",
    cwd: "/workspace/repo",
    pid: 1,
    port: 5173,
    process: "node",
    reach: "direct",
    ...over,
  };
}

function tab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <PortsTab workspaceId="w1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("a directly reachable port", () => {
  it("offers a link to the container, not to the controller", async () => {
    // The container's own address, because a process on 0.0.0.0 answers on every interface and
    // 0.0.0.0 is not somewhere a browser can go.
    view = listed(listener());
    tab();

    const link = await screen.findByRole("link", {
      name: /open port 5173/i,
    });
    expect(link).toHaveProperty("href", "http://10.0.3.100:5173/");
  });

  it("offers no way to forward it", async () => {
    view = listed(listener());
    tab();

    await screen.findByRole("link", { name: /open port 5173/i });
    expect(screen.queryByRole("button", { name: /forward/i })).toBeNull();
  });
});

describe("a loopback port", () => {
  const loopback = listener({ address: "[::1]", reach: "loopback" });

  it("offers Forward and nothing to open yet", async () => {
    view = listed(loopback);
    tab();

    await screen.findByRole("button", { name: /forward 5173/i });
    expect(screen.queryByRole("link", { name: /open port/i })).toBeNull();
  });

  it("asks the server to forward the port that was clicked", async () => {
    view = listed(loopback);
    tab();

    await userEvent.click(
      await screen.findByRole("button", { name: /forward 5173/i }),
    );

    expect(forwardPort).toHaveBeenCalledWith({
      data: { id: "w1", port: 5173 },
    });
  });

  it("says so when the forward request itself fails", async () => {
    // A thrown request, not an "unavailable" answer. It used to leave nothing on screen.
    view = listed(loopback);
    forwardPort.mockRejectedValueOnce(new Error("network is down"));
    tab();

    await userEvent.click(
      await screen.findByRole("button", { name: /forward 5173/i }),
    );

    expect(await screen.findByText("network is down")).toBeTruthy();
  });
});

describe("a forwarded port", () => {
  const forwarded = listener({
    address: "[::1]",
    forwarded: 20_000,
    reach: "loopback",
  });

  it("opens against the controller, on the allocated port", async () => {
    // Not the container and not 5173: the tunnel ends here, on a port that had to be
    // allocated because two workspaces can both be running 5173.
    view = listed(forwarded);
    tab();

    const link = await screen.findByRole("link", { name: /open port 5173/i });
    expect(link).toHaveProperty("href", "http://10.0.3.50:20000/");
  });

  it("shows both numbers, the allocated one second", async () => {
    view = listed(forwarded);
    const { container } = tab();

    await screen.findByRole("link", { name: /open port 5173/i });
    expect(container.querySelector(".ports-port")?.textContent).toBe(
      "5173 (20000)",
    );
  });

  it("carries a Stop beside the link", async () => {
    // Without it the exposure is not the revocable act that justified allowing it.
    view = listed(forwarded);
    tab();

    await userEvent.click(
      await screen.findByRole("button", { name: /stop forwarding 5173/i }),
    );

    expect(stopPort).toHaveBeenCalledWith({ data: { id: "w1", port: 5173 } });
  });
});
describe("when there is nothing to show", () => {
  it("says what was left out, rather than looking broken", async () => {
    // A container plainly running sshd with an empty tab reads as the tab failing.
    view = listed();
    tab();

    expect(
      await screen.findByText(/nothing the agent started is listening/i),
    ).toBeTruthy();
  });

  it("reports an unreachable workspace as unreachable", async () => {
    // Distinct from "nothing is listening", which is what an empty list would have claimed.
    view = { kind: "unavailable", message: "the workspace is not reachable" };
    tab();

    expect(
      await screen.findByText(/the workspace is not reachable/i),
    ).toBeTruthy();
  });
});
