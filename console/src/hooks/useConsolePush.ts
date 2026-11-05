import { useSyncExternalStore } from "react";
import { consoleApi } from "../api/modules/console";
import {
  getChatSessionScope,
  getChatSessionScopeKey,
  subscribeChatSessionScope,
} from "../stores/chatSessionScope";
import { schedulePolling } from "../utils/polling";

type PushResponse = Awaited<ReturnType<typeof consoleApi.getPushMessages>>;
const listeners = new Set<() => void>();
let messageConsumers = 0;
let snapshot: PushResponse | null = null;
let serializedSnapshot = "";
let scopeKey = "";
let stopPolling: (() => void) | undefined;
let stopScope: (() => void) | undefined;

function notify() {
  listeners.forEach((listener) => listener());
}

function syncScope() {
  const scope = getChatSessionScope();
  const sessionId = messageConsumers > 0 ? scope.sessionId : "";
  const key = JSON.stringify([scope.key, sessionId]);
  if (key === scopeKey && stopPolling) return;
  stopPolling?.();
  scopeKey = key;
  snapshot = null;
  serializedSnapshot = "";
  notify();
  // Approvals are user-wide even when messages are consumed for one session.
  // Sidebar and desktop consumers share this read without consuming another queue.
  stopPolling = schedulePolling(
    async (signal) => {
      const result = await consoleApi.getPushMessages(
        sessionId || undefined,
        signal,
      );
      if (signal.aborted || getChatSessionScopeKey() !== scope.key) return;
      const serialized = JSON.stringify(result);
      if (serialized === serializedSnapshot) return;
      serializedSnapshot = serialized;
      snapshot = result;
      notify();
    },
    { intervalMs: 2500, hiddenIntervalMs: 30_000 },
  );
}

function subscribe(listener: () => void, consumesMessages: boolean) {
  listeners.add(listener);
  if (consumesMessages) messageConsumers += 1;
  if (listeners.size === 1) {
    stopScope = subscribeChatSessionScope(syncScope);
  }
  syncScope();
  return () => {
    listeners.delete(listener);
    if (consumesMessages) messageConsumers -= 1;
    if (listeners.size === 0) {
      stopPolling?.();
      stopScope?.();
      stopPolling = undefined;
      stopScope = undefined;
      snapshot = null;
      serializedSnapshot = "";
      scopeKey = "";
    } else syncScope();
  };
}

const getSnapshot = () => {
  const scope = getChatSessionScope();
  return JSON.stringify([
    scope.key,
    messageConsumers > 0 ? scope.sessionId : "",
  ]) === scopeKey
    ? snapshot
    : null;
};
const subscribeReadOnly = (listener: () => void) => subscribe(listener, false);
const subscribeMessages = (listener: () => void) => subscribe(listener, true);

/** One live push request shared by the badge, bubbles and desktop notifications. */
export function useConsolePush(consumesMessages = false) {
  return useSyncExternalStore(
    consumesMessages ? subscribeMessages : subscribeReadOnly,
    getSnapshot,
  );
}
