import { useAgentStore } from "./agentStore";
import { useAuthStore } from "./authStore";
import {
  getAccessSessionGeneration,
  subscribeAccessSessionGeneration,
} from "../api/authSession";
import {
  getChatSessionRevision,
  subscribeChatSessionIdentity,
} from "./chatSessionIdentity";

export function getAgentAccessScopeKey() {
  const auth = useAuthStore.getState();
  return JSON.stringify([
    auth.mode,
    auth.phase,
    auth.user?.id,
    useAgentStore.getState().selectedAgent,
    getAccessSessionGeneration(),
  ]);
}

export function getChatSessionScope() {
  const auth = useAuthStore.getState();
  const agentId = useAgentStore.getState().selectedAgent;
  const sessionId =
    (window as Window & { currentSessionId?: string }).currentSessionId || "";
  return {
    sessionId,
    agentId,
    key: JSON.stringify([
      auth.mode,
      auth.phase,
      auth.user?.id,
      agentId,
      sessionId,
      getChatSessionRevision(),
      getAccessSessionGeneration(),
    ]),
  };
}

export const getChatSessionScopeKey = () => getChatSessionScope().key;

export function subscribeChatSessionScope(listener: () => void) {
  const unsubscribeAgent = useAgentStore.subscribe(listener);
  const unsubscribeUser = useAuthStore.subscribe(listener);
  const unsubscribeAuth = subscribeAccessSessionGeneration(listener);
  const unsubscribeSession = subscribeChatSessionIdentity(listener);
  return () => {
    unsubscribeAgent();
    unsubscribeUser();
    unsubscribeAuth();
    unsubscribeSession();
  };
}
