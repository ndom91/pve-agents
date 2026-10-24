// @vitest-environment happy-dom

import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parsePanel, useDrawer } from "./use-drawer";

afterEach(cleanup);

// A phone, so both panels are drawers. `show` asks the viewport first.
beforeEach(() => {
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
  })) as unknown as typeof window.matchMedia;
});

function Harness() {
  const drawer = useRef<HTMLDivElement>(null);
  const { hide, open, show } = useDrawer("nav", drawer);

  return (
    <>
      <button onClick={show} type="button">
        open
      </button>
      <div data-testid="drawer" ref={drawer} tabIndex={-1}>
        <button onClick={hide} type="button">
          close
        </button>
        <div className="terminal-host">
          <textarea aria-label="shell" />
        </div>
      </div>
      <output>{open ? "open" : "closed"}</output>
    </>
  );
}

// A real memory router rather than a mock, because the rules under test are about what the
// history does: an entry pushed on open, popped on close, replaced when there is none to pop.
function renderAt(url: string) {
  const history = createMemoryHistory({ initialEntries: [url] });
  const rootRoute = createRootRoute({
    component: Harness,
    validateSearch: (search: Record<string, unknown>) => ({
      panel: parsePanel(search.panel),
    }),
  });
  render(
    <RouterProvider router={createRouter({ history, routeTree: rootRoute })} />,
  );
  return history;
}

describe("useDrawer", () => {
  it("closes on Escape by going back, so the back gesture and Escape land in the same place", async () => {
    const history = renderAt("/");
    fireEvent.click(await screen.findByText("open"));
    await screen.findByText("open", { selector: "output" });
    expect(history.location.search).toContain("panel=nav");

    fireEvent.keyDown(document, { key: "Escape" });

    await screen.findByText("closed");
    expect(history.location.search).not.toContain("panel");
    // Back at the first entry, not on a third one pushed on top: the drawer's entry was popped.
    expect(history.location.state.__TSR_index).toBe(0);
  });

  it("moves focus into the drawer on open and back to the opener on close", async () => {
    renderAt("/");
    const opener = await screen.findByText("open");
    opener.focus();
    fireEvent.click(opener);

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("drawer")),
    );

    fireEvent.click(screen.getByText("close"));
    await screen.findByText("closed");
    expect(document.activeElement).toBe(opener);
  });

  it("closes a drawer that arrived open by replacing the URL, rather than going back off the page", async () => {
    const history = renderAt("/?panel=nav");
    await screen.findByText("open", { selector: "output" });

    fireEvent.click(screen.getByText("close"));

    await screen.findByText("closed");
    expect(history.length).toBe(1);
    expect(history.location.pathname).toBe("/");
  });

  it("does not open where the panel is a column, so a wide screen gains no history entry", async () => {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
    })) as unknown as typeof window.matchMedia;
    const history = renderAt("/");

    fireEvent.click(await screen.findByText("open"));

    expect(screen.getByText("closed")).toBeTruthy();
    expect(history.length).toBe(1);
  });

  it("leaves Escape to the shell when the terminal has focus", async () => {
    renderAt("/?panel=nav");
    await screen.findByText("open", { selector: "output" });

    fireEvent.keyDown(screen.getByLabelText("shell"), { key: "Escape" });

    expect(screen.getByText("open", { selector: "output" })).toBeTruthy();
  });
});
