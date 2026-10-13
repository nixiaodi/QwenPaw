import type { ChatSpec } from "../../api/types";

export type ChatListForAgent = (
  agentId: string,
) => Promise<Pick<ChatSpec, "id">[]>;

/** Find the owning agent for a deep-linked chat without exposing cross-agent data. */
export async function findChatAgent(
  chatId: string,
  agentIds: string[],
  listChats: ChatListForAgent,
): Promise<string | null> {
  return new Promise((resolve) => {
    if (!agentIds.length) return resolve(null);
    let remaining = agentIds.length;
    agentIds.forEach(async (agentId) => {
      try {
        const chats = await listChats(agentId);
        if (chats.some((chat) => chat.id === chatId)) resolve(agentId);
      } catch {
        // An unavailable Agent does not invalidate another Agent's match.
      } finally {
        remaining -= 1;
        if (!remaining) resolve(null);
      }
    });
  });
}
