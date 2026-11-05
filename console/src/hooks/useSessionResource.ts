import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SessionStreamOptions } from "../api/sessionEventStream";
import {
  getChatSessionScope,
  getChatSessionScopeKey,
  subscribeChatSessionScope,
} from "../stores/chatSessionScope";
import { schedulePolling } from "../utils/polling";

interface SessionResource<T> {
  load: (
    sessionId: string,
    signal: AbortSignal,
    agentId: string,
  ) => Promise<T | null>;
  subscribe: (
    receive: (
      value: T | null,
      sessionId?: string,
      rootSessionId?: string,
    ) => void,
    onError: (error: unknown) => void,
    options: SessionStreamOptions,
  ) => () => void;
}

/** Session-scoped state with single-flight polling and authoritative SSE updates. */
export function useSessionResource<T>(
  active: boolean,
  resource: SessionResource<T>,
) {
  const key = useSyncExternalStore(
    subscribeChatSessionScope,
    getChatSessionScopeKey,
  );
  const [state, setState] = useState<{
    key: string;
    value: T | null;
    loading: boolean;
  }>({ key: "", value: null, loading: false });
  const refreshRef = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    const scope = getChatSessionScope();
    if (!active || !scope.sessionId) {
      setState({ key, value: null, loading: false });
      return;
    }
    const controller = new AbortController();
    let version = 0;
    let connected = false;
    let pending: Promise<void> | null = null;
    const current = () =>
      !controller.signal.aborted && getChatSessionScopeKey() === key;
    const load = (): Promise<void> => {
      if (pending) return pending;
      if (!current()) return Promise.resolve();
      const startedVersion = version;
      setState((previous) => ({
        key,
        value: previous.key === key ? previous.value : null,
        loading: true,
      }));
      pending = (async () => {
        try {
          const value = await resource.load(
            scope.sessionId,
            controller.signal,
            scope.agentId,
          );
          if (current() && startedVersion === version)
            setState({ key, value, loading: false });
        } finally {
          if (current())
            setState((previous) => ({ ...previous, loading: false }));
          pending = null;
        }
      })();
      return pending;
    };
    const refresh = async () => {
      try {
        await load();
      } catch {
        /* Polling retries transient failures. */
      }
    };
    refreshRef.current = refresh;
    const stopPolling = schedulePolling(load, {
      intervalMs: () => (connected ? 30_000 : 5000),
    });
    const stopStream = resource.subscribe(
      (value, sessionId, rootSessionId) => {
        if (
          !current() ||
          (sessionId !== scope.sessionId && rootSessionId !== scope.sessionId)
        )
          return;
        version += 1;
        setState({ key, value, loading: false });
      },
      () => {},
      {
        agentId: scope.agentId,
        onConnectionChange: (value) => {
          if (current()) connected = value;
        },
      },
    );
    return () => {
      controller.abort();
      stopPolling();
      stopStream();
      if (refreshRef.current === refresh) refreshRef.current = async () => {};
    };
  }, [active, key, resource]);

  const refresh = useCallback(() => refreshRef.current(), []);
  const visible = active && state.key === key;
  return {
    value: visible ? state.value : null,
    loading: visible && state.loading,
    refresh,
  };
}
