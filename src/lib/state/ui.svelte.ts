// Global UI state. Cross-cutting overlays (ctx menu, drill popover, terminal)
// would otherwise force prop-drilling through every depth; Svelte 5 module-level
// $state covers it cleanly.

export type Module = "dashboard" | "distribute";
export type Metric = "latency" | "loss" | "tx";
export type Direction = "sym" | "ab";
export type DistView = "compose" | "result" | "history";

export interface CtxMenuItem {
  label?: string;
  sub?: string;
  hint?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  divider?: boolean;
}

export interface CtxMenuState {
  x: number;
  y: number;
  items: CtxMenuItem[];
}

export interface DrillState {
  aId: string;
  bId: string;
  x: number;
  y: number;
}

export interface TermSession {
  id: string;
  nodeId: string;
  channel: "agent" | "ssh";
  cwd: string;
  lines: TermLine[];
  history: string[];
  historyIdx: number;
  disconnected: boolean;
}

export interface TermLine {
  kind: "sys" | "sys-dim" | "out" | "err" | "prompt";
  text: string;
  cmd?: string;
}

export interface Preset {
  id: string;
  name: string;
  steps: string[];
  created: string;
}

export const ui = $state({
  module: "dashboard" as Module,
  metric: "latency" as Metric,
  direction: "sym" as Direction,
  selectedNodeId: "archmbp",

  distCapId: "ca",
  distView: "compose" as DistView,
  presets: [
    {
      id: "preset-onboard",
      name: "上线一台新机器",
      steps: ["ssh", "ca", "dns"],
      created: "2026-04-08",
    },
    { id: "preset-ca", name: "CA quarterly rotate", steps: ["ca"], created: "2026-04-01" },
  ] as Preset[],

  ctxMenu: null as CtxMenuState | null,
  drill: null as DrillState | null,
  termSessions: [] as TermSession[],
  termActive: null as string | null,
  termOpen: false,
  cmdkOpen: false,
  gPrefix: false,
  panelCollapsed: false,
});

export function openContextMenu(menu: CtxMenuState) {
  ui.ctxMenu = menu;
}
export function closeContextMenu() {
  ui.ctxMenu = null;
}
export function openDrill(d: DrillState) {
  ui.drill = d;
}
export function closeDrill() {
  ui.drill = null;
}

export function selectNode(id: string) {
  ui.selectedNodeId = id;
  ui.panelCollapsed = false;
}

import { NODES } from "$lib/data/mock-nodes";
import { makeInitTerminalLines } from "$lib/data/terminal-mock";

export function openSSH(nodeId: string) {
  const node = NODES.find((n) => n.id === nodeId);
  if (!node) return;
  const channel: "agent" | "ssh" | null =
    node.agent === "online" ? "agent" : node.mesh !== "offline" ? "ssh" : null;
  if (!channel) return;
  const existing = ui.termSessions.find((s) => s.nodeId === nodeId);
  if (existing) {
    ui.termActive = existing.id;
    ui.termOpen = true;
    return;
  }
  const id = Math.random().toString(36).slice(2, 9);
  const next: TermSession[] = [
    ...ui.termSessions,
    {
      id,
      nodeId,
      channel,
      cwd: "~",
      lines: makeInitTerminalLines(node, channel),
      history: [],
      historyIdx: -1,
      disconnected: false,
    },
  ].slice(-4);
  ui.termSessions = next;
  ui.termActive = id;
  ui.termOpen = true;
}

export function closeTermTab(id: string) {
  const next = ui.termSessions.filter((s) => s.id !== id);
  ui.termSessions = next;
  if (ui.termActive === id) {
    ui.termActive = next.length ? next[next.length - 1].id : null;
    if (next.length === 0) ui.termOpen = false;
  }
}
