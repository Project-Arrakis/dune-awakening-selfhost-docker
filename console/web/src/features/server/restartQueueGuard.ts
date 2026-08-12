import { serverApi, type RestartDispatchResponse, type RestartQueueState, type RestartQueueTarget } from "../../api/server";
import type { Task } from "../../api/setup";

// Result of the restart-queue interception dialog. "immediate" bypasses the
// queue (the restart runs now); "queue" lets the backend capture it into a
// countdown; "cancel" aborts.
export type RestartGateChoice = "queue" | "immediate" | "cancel";

export type RestartGateDetail = { label: string; value: string; tone?: "accent" | "success" | "danger" };

export type RestartGateMeta = {
  label: string;
  enabled: boolean;
  playersOnline: number | null;
  // Battlegroup-wide count, for context alongside a map-scoped playersOnline.
  // Equal to playersOnline for a battlegroup-wide restart.
  battlegroupPlayersOnline: number | null;
  countdownMinutes: number;
  note?: string;
  details?: RestartGateDetail[];
};

// The interception presenter, provided by App (restartGateChoice). It shows the
// single confirmation dialog for a restart and returns the choice; it performs
// no dispatch. It is ALWAYS called (even when the queue is disabled) so a
// destructive restart always gets one confirmation.
export type RestartGate = (meta: RestartGateMeta) => Promise<RestartGateChoice>;

export type GatedRestartResult =
  | { outcome: "cancelled" }
  | { outcome: "queued"; online: number; state?: RestartQueueState }
  | { outcome: "dispatched"; task: Task | undefined };

// Wraps a restart in the queue interception. It ALWAYS shows exactly one
// confirmation dialog (the sole confirm for the action): a plain confirm when
// the queue is off or nobody is online, or the Queue / Restart Immediately /
// Cancel choice when the queue is on and players are online. Callers dispatch
// through `dispatch`, which receives `{ immediate }` and calls the matching
// `serverApi.*({ immediate })`. Optional `note`/`details` decorate the dialog
// (e.g. a sietch's "other sietches keep running" impact line).
export async function runGatedRestart(params: {
  restartGate: RestartGate;
  label: string;
  dispatch: (opts: { immediate: boolean }) => Promise<RestartDispatchResponse>;
  note?: string;
  details?: RestartGateDetail[];
  // The specific map/partition this restart targets. Omit for a
  // battlegroup-wide restart. Scopes the online check to that map, so a
  // restart only queues (or blocks/warns) based on who is actually there.
  target?: RestartQueueTarget;
}): Promise<GatedRestartResult> {
  let status: Awaited<ReturnType<typeof serverApi.restartQueue>> | null = null;
  try {
    status = await serverApi.restartQueue(params.target);
  } catch {
    status = null;
  }
  const choice = await params.restartGate({
    label: params.label,
    enabled: status?.settings.enabled ?? false,
    playersOnline: status?.playersOnline ?? null,
    battlegroupPlayersOnline: status?.battlegroupPlayersOnline ?? status?.playersOnline ?? null,
    countdownMinutes: status?.settings.defaultCountdownMinutes ?? 15,
    note: params.note,
    details: params.details
  });
  if (choice === "cancel") return { outcome: "cancelled" };
  const response = await params.dispatch({ immediate: choice === "immediate" });
  if (response.queued) {
    return { outcome: "queued", online: response.online ?? status?.playersOnline ?? 0, state: response.state };
  }
  return { outcome: "dispatched", task: response.task };
}
