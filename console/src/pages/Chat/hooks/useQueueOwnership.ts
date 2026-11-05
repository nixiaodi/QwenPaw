import { useCallback, useEffect, useRef, useState } from "react";
import { holdOwnershipLock } from "../../../stores/messageQueueStore";

export type QueueOwnershipStatus =
  | "checking"
  | "owner"
  | "other-owner"
  | "error";
export const OWNERSHIP_RETRY_MS = 1000;

/** Recover failed requests without bypassing cross-tab exclusion. */
export function useQueueOwnership(
  sessionId: string,
  ownerScope: string,
  enabled = true,
) {
  const scope = JSON.stringify([sessionId, ownerScope, enabled]);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    status: QueueOwnershipStatus;
  }>({ scope, status: "checking" });
  const retryRef = useRef<() => void>(() => {});
  const retry = useCallback(() => retryRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const update = (status: QueueOwnershipStatus) => {
      if (!disposed) setSnapshot({ scope, status });
    };
    const schedule = () => {
      if (!disposed)
        timer = setTimeout(() => void attempt(), OWNERSHIP_RETRY_MS);
    };
    async function attempt() {
      if (disposed || inFlight || !enabled) return;
      clearTimeout(timer);
      inFlight = true;
      try {
        const outcome = await holdOwnershipLock(
          sessionId,
          () => update("owner"),
          controller.signal,
        );
        if (disposed || outcome === "unsupported") return;
        update(outcome === "unavailable" ? "other-owner" : "checking");
        schedule();
      } catch {
        update("error");
        schedule();
      } finally {
        inFlight = false;
      }
    }
    update("checking");
    retryRef.current = () => void attempt();
    void attempt();
    const onResume = () => {
      if (document.visibilityState !== "hidden") void attempt();
    };
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      retryRef.current = () => {};
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [sessionId, scope, enabled]);

  const status =
    snapshot.scope === scope && enabled ? snapshot.status : "checking";
  return { status, isOwner: status === "owner", retry };
}
