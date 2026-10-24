import { useQuery } from "@tanstack/react-query";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";

import { fleetQuery } from "../lib/queries";
import { isWaiting } from "../lib/use-blocked-alerts";
import { useDrawer } from "../lib/use-drawer";
import { IconButton } from "./icon-button";

// NavButton opens the sidebar where the sidebar is a drawer, and sits first in each page's bar.
//
// It carries the sidebar's waiting count while the sidebar is out of sight. The banner saying an
// agent is waiting lives in the sidebar, and folding the sidebar away folded the one alert that
// asks for a person away with it.
export function NavButton(): ReactNode {
  const nav = useDrawer("nav");
  // The layout already holds this query, so this is a cache read rather than a second fetch.
  const { data: workspaces = [] } = useQuery(fleetQuery());
  const waiting = workspaces.filter(isWaiting).length;

  return (
    <span className="nav-open">
      <IconButton
        expanded={nav.open}
        icon={Menu}
        label={
          waiting === 0
            ? "Open menu"
            : `Open menu, ${waiting} ${waiting === 1 ? "agent is" : "agents are"} waiting`
        }
        onClick={nav.show}
        variant="tertiary"
      />
      {waiting === 0 ? null : (
        <span aria-hidden="true" className="nav-open-dot" />
      )}
    </span>
  );
}
