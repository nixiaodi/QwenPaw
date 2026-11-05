import type { ChatSpec } from "../api/types/chat";

export function asChatPage(items: ChatSpec[]) {
  return { items, has_more: false, next_cursor: null };
}
