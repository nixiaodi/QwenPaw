import { useCallback, useEffect, useRef, useState } from "react";
import {
  runtimeStatusApi,
  subscribeRuntimeStatusUpdates,
  type RuntimeStatus,
} from "../../api/modules/runtimeStatus";

function getBackendSessionId(): string {
  return (window as any).currentSessionId || "";
}

export function useRuntimeStatus(active: boolean) {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  const prevBackendSidRef = useRef("");
  const updateVersionRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    const sid = getBackendSessionId();
    if (sid !== prevBackendSidRef.current) {
      prevBackendSidRef.current = sid;
      setStatus(null);
    }
    if (!sid) {
      setStatus(null);
      return;
    }
    const version = ++updateVersionRef.current;
    try {
      const data = await runtimeStatusApi.getCurrent(sid);
      if (
        getBackendSessionId() === sid &&
        version === updateVersionRef.current
      ) {
        setStatus(
          data?.status === "completed" || data?.status === "idle" ? null : data,
        );
      }
    } catch {
      // ignore transient polling errors
    }
  }, []);

  useEffect(() => {
    if (!active) {
      updateVersionRef.current += 1;
      setStatus(null);
      return;
    }
    fetchStatus();
  }, [active, fetchStatus]);

  useEffect(() => {
    if (!active) return;
    const unsub = subscribeRuntimeStatusUpdates(
      (updated, eventSessionId, eventRootSessionId) => {
        const mySid = getBackendSessionId();
        if (
          !mySid ||
          (eventSessionId !== mySid && eventRootSessionId !== mySid)
        ) {
          return;
        }
        updateVersionRef.current += 1;
        setStatus(updated);
      },
    );
    return () => unsub();
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, [active, fetchStatus]);

  return { status, refresh: fetchStatus };
}
