import { request } from "../request";
import {
  subscribeSessionEvents,
  type SessionStreamOptions,
} from "../sessionEventStream";
import {
  withAgentRequestContext,
  type AgentRequestContext,
} from "./agentRequestContext";

export interface SubTaskResponse {
  name: string;
  description: string;
  expected_outcome: string;
  outcome: string | null;
  state: "todo" | "in_progress" | "done" | "abandoned";
  created_at: string | null;
  finished_at: string | null;
}

export interface PlanStateResponse {
  id: string;
  name: string;
  description: string;
  expected_outcome: string;
  state: "todo" | "in_progress" | "done" | "abandoned";
  subtasks: SubTaskResponse[];
  created_at: string | null;
  finished_at: string | null;
  outcome: string | null;
}

export interface PlanConfigResponse {
  enabled: boolean;
  auto_enabled: boolean;
  auto_execute: boolean;
  complexity_threshold: string;
}

export const planApi = {
  getCurrentPlan: (
    sessionId?: string,
    options?: { signal?: AbortSignal; agentId?: string },
  ) =>
    request<PlanStateResponse | null>(
      sessionId
        ? `/plan/current?session_id=${encodeURIComponent(sessionId)}`
        : "/plan/current",
      ...(options
        ? [withAgentRequestContext({ signal: options.signal }, options)]
        : []),
    ),

  getPlanConfig: (context?: AgentRequestContext) => {
    const options = withAgentRequestContext(undefined, context);
    return options
      ? request<PlanConfigResponse>("/plan/config", options)
      : request<PlanConfigResponse>("/plan/config");
  },

  updatePlanConfig: (body: PlanConfigResponse, context?: AgentRequestContext) =>
    request<PlanConfigResponse>(
      "/plan/config",
      withAgentRequestContext(
        {
          method: "PUT",
          body: JSON.stringify(body),
        },
        context,
      ),
    ),
};

/**
 * Subscribe to plan updates via SSE using fetch streaming.
 * Returns an unsubscribe function.
 */
export function subscribePlanUpdates(
  onUpdate: (
    plan: PlanStateResponse | null,
    sessionId: string | undefined,
  ) => void,
  onError?: (err: unknown) => void,
  options?: SessionStreamOptions,
): () => void {
  return subscribeSessionEvents<{
    type: string;
    plan?: PlanStateResponse | null;
    session_id?: string;
  }>(
    "/plan/stream",
    (data) => {
      if (data.type === "plan_update") {
        onUpdate(data.plan ?? null, data.session_id);
      }
    },
    onError,
    options,
  );
}
