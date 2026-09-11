import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Lets a route render into two spots inside AppShell's own header — between the "Kaigara" title
 * and the pill-shaped stage nav, and just before the theme toggle — instead of opening a second
 * header row of its own underneath it. Compose is the one route that currently uses this (its
 * scenario name + Visual/Code toggle in the first slot, Upload/Download/Save/Run in the second);
 * every other route simply never renders into either slot, so their two containers stay empty and
 * AppShell's header looks exactly as it did before this existed.
 *
 * Implemented as a portal rather than lifting the header content into AppShell/route state: the
 * header's *position* is owned by AppShell, but its *content* (and the handlers/local state behind
 * it) stays owned by whichever page is rendering it — the usual "portal into a slot the parent
 * exposes" split.
 */
interface HeaderSlotElements {
  scenario: HTMLDivElement | null;
  actions: HTMLDivElement | null;
}

const HeaderSlotsContext = createContext<HeaderSlotElements>({ scenario: null, actions: null });

export const HeaderSlotsProvider = HeaderSlotsContext.Provider;

/** Portals `children` into AppShell's header, right after the "Kaigara" title. */
export function HeaderScenarioSlot({ children }: { children: ReactNode }) {
  const { scenario } = useContext(HeaderSlotsContext);
  // Null for exactly one render — AppShell's ref callback has to fire and set state before the
  // container div exists to portal into. Rendering nothing that one frame beats portalling into a
  // node that is about to be thrown away.
  return scenario ? createPortal(children, scenario) : null;
}

/** Portals `children` into AppShell's header, right before the theme toggle. */
export function HeaderActionsSlot({ children }: { children: ReactNode }) {
  const { actions } = useContext(HeaderSlotsContext);
  return actions ? createPortal(children, actions) : null;
}
