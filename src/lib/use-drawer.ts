import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { type RefObject, useCallback, useEffect } from "react";

// The two side columns, which on a narrow screen are drawers over the chat rather than columns
// beside it. "nav" is the sidebar, "rail" the workspace's details.
export type DrawerPanel = "nav" | "rail";

declare module "@tanstack/react-router" {
  interface HistoryState {
    // Set on the entry pushed to open a drawer, so closing it can tell whether going back lands
    // on this page without the drawer or leaves the page entirely.
    drawer?: DrawerPanel;
  }
}

// parsePanel is the `panel` search param's validator. Anything else in the URL means no drawer.
export function parsePanel(value: unknown): DrawerPanel | undefined {
  return value === "nav" || value === "rail" ? value : undefined;
}

// useDrawer opens and closes one drawer, by way of the URL.
//
// In the URL rather than in state so that the phone's back gesture closes a drawer, which is what
// it is expected to do. Opening pushes an entry; closing goes back over it, so the close button,
// Escape and the back gesture all land in the same place. A drawer that arrived open -- a reload,
// a pasted link -- has no entry of ours under it, and going back would leave the page; that one
// is closed by replacing the URL instead.
//
// Whether the drawer is visible at all is the stylesheet's business: below the breakpoints the
// `data-panel` on `.dashboard` slides it in, above them the param is inert.
//
// `element` is the drawer itself. Focus moves into it on open and back to whatever had it on
// close, so a keyboard is never left on a control hidden underneath. It also answers whether the
// panel is a drawer right now; a caller without it, like the menu button, is only ever visible
// where it is.
export function useDrawer(
  panel: DrawerPanel,
  element?: RefObject<HTMLElement | null>,
) {
  const router = useRouter();
  const navigate = useNavigate();
  const open = useSearch({
    select: (search) => search.panel === panel,
    strict: false,
  });

  // A no-op where the panel is a column rather than a drawer. Otherwise a wide screen would gain a
  // history entry for a drawer it never shows, and the back button would spend a press on it.
  //
  // Asked of the element rather than of a media query, because the stylesheet is what makes it a
  // drawer -- `position: fixed` below the breakpoint -- and a second copy of the breakpoint here
  // would be one that could be moved without the other.
  const show = useCallback(() => {
    const drawer = element?.current;
    if (drawer && getComputedStyle(drawer).position !== "fixed") {
      return;
    }
    void navigate({
      search: (prev) => ({ ...prev, panel }),
      state: { drawer: panel },
      to: ".",
    });
  }, [element, navigate, panel]);

  const hide = useCallback(() => {
    if (router.state.location.state.drawer === panel) {
      router.history.back();
      return;
    }
    void navigate({
      replace: true,
      search: (prev) => ({ ...prev, panel: undefined }),
      to: ".",
    });
  }, [navigate, panel, router]);

  useEffect(() => {
    if (!open || element === undefined) {
      return;
    }

    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element.current?.focus({ preventScroll: true });

    function onKey(event: KeyboardEvent) {
      // Not when the terminal has it: Escape there belongs to the shell, and a hardware keyboard
      // on a tablet is exactly where somebody would press it to leave vim.
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest(".terminal-host") !== null)
      ) {
        return;
      }
      hide();
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus({ preventScroll: true });
    };
  }, [element, hide, open]);

  return { hide, open, show };
}
