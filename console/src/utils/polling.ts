interface PollingOptions {
  intervalMs: number | (() => number);
  /** Omit to pause in hidden tabs; notifications may keep a slower cadence. */
  hiddenIntervalMs?: number;
  immediate?: boolean;
}

/** Schedule the next request after completion, never alongside a slow one. */
export function schedulePolling(
  task: (signal: AbortSignal) => Promise<void>,
  { intervalMs, hiddenIntervalMs, immediate = true }: PollingOptions,
): () => void {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let failures = 0;
  const canRun = () =>
    !controller.signal.aborted &&
    navigator.onLine !== false &&
    (!document.hidden || hiddenIntervalMs !== undefined);

  function schedule() {
    clearTimeout(timer);
    if (!canRun()) return;
    const base = document.hidden
      ? hiddenIntervalMs!
      : typeof intervalMs === "function"
      ? intervalMs()
      : intervalMs;
    timer = setTimeout(
      () => void run(),
      Math.max(base, Math.min(30_000, base * 2 ** failures)),
    );
  }

  async function run() {
    if (running || !canRun()) return;
    running = true;
    try {
      await task(controller.signal);
      failures = 0;
    } catch {
      // Slow or unavailable servers receive fewer requests until recovery.
      failures = Math.min(failures + 1, 5);
    } finally {
      running = false;
      schedule();
    }
  }

  const onAvailability = () => {
    clearTimeout(timer);
    if (running || !canRun()) return;
    if (document.hidden) schedule();
    else void run();
  };
  document.addEventListener("visibilitychange", onAvailability);
  window.addEventListener("online", onAvailability);
  window.addEventListener("offline", onAvailability);
  if (immediate && !document.hidden) void run();
  else schedule();

  return () => {
    controller.abort();
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onAvailability);
    window.removeEventListener("online", onAvailability);
    window.removeEventListener("offline", onAvailability);
  };
}
