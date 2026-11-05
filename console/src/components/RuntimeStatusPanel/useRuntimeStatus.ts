import {
  runtimeStatusApi,
  subscribeRuntimeStatusUpdates,
  type RuntimeStatus,
} from "../../api/modules/runtimeStatus";
import { useSessionResource } from "../../hooks/useSessionResource";

const resource = {
  load: async (
    sessionId: string,
    signal: AbortSignal,
    agentId: string,
  ): Promise<RuntimeStatus | null> => {
    const value = await runtimeStatusApi.getCurrent(sessionId, {
      signal,
      agentId,
    });
    return value?.status === "completed" || value?.status === "idle"
      ? null
      : value;
  },
  subscribe: subscribeRuntimeStatusUpdates,
};

export function useRuntimeStatus(active: boolean) {
  const { value, loading, refresh } = useSessionResource(active, resource);
  return { status: value, loading, refresh };
}
