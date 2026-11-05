import { request } from "../request";
import { withAgentRequestContext } from "./agentRequestContext";
import {
  subscribeSessionEvents,
  type SessionStreamOptions,
} from "../sessionEventStream";

export type UserInputQuestionKind =
  | "single_choice"
  | "free_text"
  | "choice_with_custom";

export type UserInputStatus =
  | "pending"
  | "answered"
  | "ignored"
  | "timeout"
  | "cancelled";

export interface UserInputOption {
  label: string;
  value: string;
  description?: string | null;
  recommended?: boolean;
}

export interface UserInputQuestion {
  id: string;
  question: string;
  kind: UserInputQuestionKind;
  options: UserInputOption[];
  placeholder?: string | null;
  required: boolean;
  default_value?: string | null;
}

export interface UserInputRequest {
  request_id: string;
  agent_id: string;
  session_id: string;
  root_session_id: string;
  user_id: string;
  channel: string;
  title?: string | null;
  questions: UserInputQuestion[];
  question_index: number;
  total_questions: number;
  status: UserInputStatus;
  created_at: number;
  timeout_seconds: number;
}

export interface UserInputAnswerPayload {
  answers: Record<string, unknown>;
  action: "submit" | "ignore" | "cancel";
}

export const userInputApi = {
  getPending: (
    sessionId: string,
    options?: { signal?: AbortSignal; agentId?: string },
  ) =>
    request<UserInputRequest | null>(
      `/user-input/pending?session_id=${encodeURIComponent(sessionId)}`,
      ...(options
        ? [withAgentRequestContext({ signal: options.signal }, options)]
        : []),
    ),

  answer: (requestId: string, body: UserInputAnswerPayload) =>
    request<UserInputRequest>(`/user-input/${requestId}/answer`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export function subscribeUserInputUpdates(
  onUpdate: (
    request: UserInputRequest | null,
    sessionId: string | undefined,
    rootSessionId: string | undefined,
  ) => void,
  onError?: (err: unknown) => void,
  options?: SessionStreamOptions,
): () => void {
  return subscribeSessionEvents<{
    type: string;
    request?: UserInputRequest | null;
    session_id?: string;
    root_session_id?: string;
  }>(
    "/user-input/stream",
    (data) => {
      if (
        data.type === "user_input_request" ||
        data.type === "user_input_update"
      ) {
        onUpdate(
          data.request?.status === "pending" ? data.request : null,
          data.session_id,
          data.root_session_id,
        );
      }
    },
    onError,
    options,
  );
}
