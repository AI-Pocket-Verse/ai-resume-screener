import { env as procEnv } from "node:process";

// Dual-timer guard for streaming LLM CLI subprocesses. Previously each
// provider used a single wall-clock timer (default 120s) that killed
// the CLI even when it was actively producing tokens — long, healthy
// answers got SIGKILL'd. The dual-timer split is:
//
//   - IDLE timer: reset on every received token. Fires only when the
//     CLI has been silent for `idleMs` ms (default 90s). Catches real
//     hangs without punishing slow / verbose answers.
//   - HARD timer: never reset. Absolute upper bound (default 600s /
//     10min) so a chatty CLI that streams a single character per
//     second forever can't camp on a semaphore slot.
//
// Env overrides:
//   - LLM_IDLE_TIMEOUT_MS (also accepts legacy LLM_TIMEOUT_MS as alias
//     so existing deployments keep working without surprise behavior)
//   - LLM_HARD_TIMEOUT_MS
export interface IdleHardTimer {
  /** Reset the idle timer — call when the CLI emits any token / event. */
  arm(): void;
  /** Cleanup both timers; safe to call multiple times. */
  disarm(): void;
  /** "" if neither fired; "idle" or "hard" once one did. */
  reason: () => "" | "idle" | "hard";
  /** Configured idle ms (for human-readable error messages). */
  idleMs: number;
  /** Configured hard cap ms (for human-readable error messages). */
  hardMs: number;
}

export function startIdleHardTimer(
  onTimeout: (reason: "idle" | "hard") => void,
  // Per-call overrides win over the env defaults.
  opts: { idleMs?: number; hardMs?: number } = {},
): IdleHardTimer {
  const idleMs = opts.idleMs ?? Number(procEnv.LLM_IDLE_TIMEOUT_MS ?? procEnv.LLM_TIMEOUT_MS ?? 90_000);
  const hardMs = opts.hardMs ?? Number(procEnv.LLM_HARD_TIMEOUT_MS ?? 600_000);
  let idleTimer: NodeJS.Timeout | null = null;
  let reason: "" | "idle" | "hard" = "";

  const hardTimer = setTimeout(() => {
    if (reason) return;
    reason = "hard";
    onTimeout("hard");
  }, hardMs);

  function arm(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (reason) return;
      reason = "idle";
      onTimeout("idle");
    }, idleMs);
  }

  function disarm(): void {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    clearTimeout(hardTimer);
  }

  arm();
  return { arm, disarm, reason: () => reason, idleMs, hardMs };
}
