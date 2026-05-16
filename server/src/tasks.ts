// Task result projection + in-memory history store.
//
// All apply endpoints (mesh/dns/ca) produce ApplyLog[] internally — a per-node
// list of step results. The UI's ResultView speaks a different shape: a matrix
// indexed by [row=node][col=step]. applyLogsToTaskResult is the projection.

// ── input shape produced by apply functions ────────────────────────────

export interface ApplyLog {
  node: string;
  steps: Array<{ step: string; ok: boolean; detail?: string }>;
}

// ── output shape consumed by the UI's task result matrix ──────────────

export type CellKind = "ok" | "fail" | "warn" | "skip" | "run" | "queue";

export interface TaskRow {
  node: string;
  mesh: "online" | "degraded" | "offline";
  agent: "online" | "offline";
  cells: CellKind[];
  failStep?: number;
}

export interface TaskResult {
  id: string;
  name: string;
  startedAt: string;
  finishedAt: string;
  elapsed: string;
  steps: string[];
  rows: TaskRow[];
  failDetails?: Record<string, { cmd: string; exit: number; duration: string; stderr: string }>;
}

// ── store ──────────────────────────────────────────────────────────────
// Apply endpoints return TaskResult synchronously; we also remember them so
// the History view can list recent runs. Capped at MAX_TASK_HISTORY entries.

const MAX_TASK_HISTORY = 50;
export const tasks: TaskResult[] = [];

function newTaskId(): string {
  return `task-${Math.floor(Date.now() / 1000).toString(36)}`;
}

function fmtHms(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function applyLogsToTaskResult(
  name: string,
  logs: ApplyLog[],
  startedAt: number,
): TaskResult {
  // Take the union of step names in encounter order. Apply paths short-circuit
  // on failure, so some logs have fewer steps than others; we backfill "skip".
  const canonicalSteps: string[] = [];
  for (const log of logs) {
    for (const s of log.steps) if (!canonicalSteps.includes(s.step)) canonicalSteps.push(s.step);
  }

  const failDetails: NonNullable<TaskResult["failDetails"]> = {};
  const rows: TaskRow[] = logs.map((log) => {
    const cells: CellKind[] = canonicalSteps.map((stepName) => {
      const step = log.steps.find((s) => s.step === stepName);
      if (!step) return "skip";
      return step.ok ? "ok" : "fail";
    });
    const failStep = cells.indexOf("fail");
    // Collect stderr/details for failed steps so the UI can show them inline.
    for (let i = 0; i < log.steps.length; i++) {
      const s = log.steps[i];
      if (!s.ok && s.detail) {
        const idx = canonicalSteps.indexOf(s.step);
        if (idx >= 0) {
          failDetails[`${log.node}:${idx}`] = {
            cmd: s.step,
            exit: -1,
            duration: "—",
            stderr: s.detail,
          };
        }
      }
    }
    return {
      node: log.node,
      mesh: "online",
      agent: "offline",
      cells,
      failStep: failStep >= 0 ? failStep : undefined,
    };
  });

  const result: TaskResult = {
    id: newTaskId(),
    name,
    startedAt: fmtHms(startedAt),
    finishedAt: fmtHms(Date.now()),
    elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    steps: canonicalSteps,
    rows,
    failDetails: Object.keys(failDetails).length ? failDetails : undefined,
  };
  tasks.unshift(result);
  if (tasks.length > MAX_TASK_HISTORY) tasks.length = MAX_TASK_HISTORY;
  return result;
}
