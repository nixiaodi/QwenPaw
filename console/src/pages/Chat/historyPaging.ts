import { create } from "zustand";
import { getAccessSessionGeneration } from "../../api/authSession";
import { useAgentStore } from "../../stores/agentStore";
import type { ChatHistory } from "../../api/types/chat";

export const HISTORY_PAGE_SIZE = 5;
export const historyScope = () =>
  `${getAccessSessionGeneration()}:${useAgentStore.getState().selectedAgent}`;
export const historyPageKey = (chatId: string) => `${historyScope()}:${chatId}`;

type Cursor = { hasMore: boolean; before: number | null };
export const useHistoryPaging = create<{ pages: Record<string, Cursor> }>(
  () => ({ pages: {} }),
);

// Store cursors only; message content remains owned by the active SDK session.
export function rememberHistoryPage(key: string, page: ChatHistory) {
  useHistoryPaging.setState(({ pages }) => ({
    pages: Object.fromEntries([
      ...Object.entries(pages)
        .filter(([entry]) => entry !== key)
        .slice(-99),
      [
        key,
        { hasMore: page.has_more === true, before: page.next_before ?? null },
      ],
    ]),
  }));
}
