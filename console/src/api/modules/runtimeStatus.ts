import { request } from "../request";
import { withAgentRequestContext } from "./agentRequestContext";
import {
  subscribeSessionEvents,
  type SessionStreamOptions,
} from "../sessionEventStream";

export type RuntimeStatusKind = "running" | "failed" | "completed" | "idle";

export interface RuntimeStatus {
  type: "runtime_status";
  event_id: string;
  agent_id: string;
  session_id: string;
  root_session_id: string;
  chat_id?: string | null;
  stage: string;
  status: RuntimeStatusKind;
  message: string;
  detail: Record<string, unknown>;
  ts: number;
}

export const runtimeStatusApi = {
  getCurrent: (
    sessionId: string,
    options?: { signal?: AbortSignal; agentId?: string },
  ) =>
    request<RuntimeStatus | null>(
      `/runtime-status/current?session_id=${encodeURIComponent(sessionId)}`,
      ...(options
        ? [withAgentRequestContext({ signal: options.signal }, options)]
        : []),
    ),
};

export function subscribeRuntimeStatusUpdates(
  onUpdate: (
    status: RuntimeStatus | null,
    sessionId: string | undefined,
    rootSessionId: string | undefined,
  ) => void,
  onError?: (err: unknown) => void,
  options?: SessionStreamOptions,
): () => void {
  return subscribeSessionEvents<RuntimeStatus>(
    "/runtime-status/stream",
    (data) => {
      if (data.type === "runtime_status") {
        onUpdate(
          data.status === "completed" || data.status === "idle" ? null : data,
          data.session_id,
          data.root_session_id,
        );
      }
    },
    onError,
    options,
  );
}
