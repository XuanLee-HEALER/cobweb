// Reactive distribute-task state. Populated on demand by the ComposeView
// "Execute" button and synced with /api/tasks on init.

import type { TaskResult } from "@cobweb/server";
import { api } from "../api/client";

export type { CellKind, TaskRow } from "@cobweb/server";
export type { TaskResult };

export const tasks = $state({
  /** in-flight flag per capability while an apply is pending. */
  running: {} as Record<string, boolean>,
  /** most recent result per capability id. */
  byCapId: {} as Record<string, TaskResult | undefined>,
  /** newest-first list of recent tasks. */
  history: [] as TaskResult[],
});

/** Pull the recent task list once on app start. */
export async function loadTaskHistory(): Promise<void> {
  try {
    const r = await api.api.tasks.$get();
    if (!r.ok) return;
    const list = (await r.json()) as TaskResult[];
    tasks.history = list;
    // hydrate byCapId with the latest per-capability result
    const byCap: Record<string, TaskResult> = {};
    for (const t of list) {
      const cap = capIdFromTaskName(t.name);
      if (cap && !byCap[cap]) byCap[cap] = t;
    }
    tasks.byCapId = byCap;
  } catch {
    // backend offline; UI shows "no recent task"
  }
}

function capIdFromTaskName(name: string): string | null {
  if (name.startsWith("CA ")) return "ca";
  if (name.startsWith("DNS ")) return "dns";
  if (name.startsWith("SSH key")) return "ssh";
  if (name.startsWith("cobweb-agent")) return "agent";
  return null;
}

type Endpoint = "ca" | "dns" | "ssh" | "agent";

/** Run an apply and store the resulting TaskResult into state. */
export async function runApply(cap: Endpoint): Promise<TaskResult | null> {
  tasks.running[cap] = true;
  try {
    const r =
      cap === "ca"
        ? await api.api.mesh.ca.apply.$post()
        : cap === "dns"
          ? await api.api.mesh.dns.apply.$post()
          : cap === "agent"
            ? await api.api.mesh.agent.install.$post({ json: {} })
            : await api.api.mesh.apply.$post(); // ssh = /api/mesh/apply
    if (!r.ok) {
      const err = await r.text();
      console.warn(`apply ${cap} failed:`, err);
      return null;
    }
    const result = (await r.json()) as TaskResult;
    tasks.byCapId[cap] = result;
    tasks.history = [result, ...tasks.history].slice(0, 50);
    return result;
  } catch (e) {
    console.warn(`apply ${cap} threw:`, e);
    return null;
  } finally {
    tasks.running[cap] = false;
  }
}
