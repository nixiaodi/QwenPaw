import { chatApi } from "../../../api/modules/chat";

export type SessionViewInspection = { kind: "chat" } | { kind: "empty" };

export async function inspectSessionForView(
  sessionId: string,
): Promise<SessionViewInspection> {
  const summary = await chatApi.getChatSummary(sessionId);
  return summary.has_messages ? { kind: "chat" } : { kind: "empty" };
}
