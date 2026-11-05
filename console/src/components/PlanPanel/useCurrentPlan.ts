import {
  planApi,
  subscribePlanUpdates,
  type PlanStateResponse,
} from "../../api/modules/plan";
import { useSessionResource } from "../../hooks/useSessionResource";

const resource = {
  load: async (
    sessionId: string,
    signal: AbortSignal,
    agentId: string,
  ): Promise<PlanStateResponse | null> => {
    const value = await planApi.getCurrentPlan(sessionId, { signal, agentId });
    return value;
  },
  subscribe: subscribePlanUpdates,
};

export function useCurrentPlan(active: boolean) {
  const { value, loading, refresh } = useSessionResource(active, resource);
  return { plan: value, loading, refresh };
}
