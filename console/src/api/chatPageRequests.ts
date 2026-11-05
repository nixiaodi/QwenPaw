import { request } from "./request";
import type { ChatListPage, ChatListQuery } from "./types/chat";
import { useAgentStore } from "../stores/agentStore";
import {
  getAgentAccessScopeKey,
  subscribeChatSessionScope,
} from "../stores/chatSessionScope";

const pending = new Map<
  string,
  {
    promise: Promise<ChatListPage>;
    controller: AbortController;
    readers: number;
  }
>();

/** SDK, sidebar and drawer share concurrent pages, but never identity epochs. */
export function requestChatPage(
  query: ChatListQuery = {},
  signal?: AbortSignal,
): Promise<ChatListPage> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  const params = new URLSearchParams({
    page_size: String(query.page_size ?? 20),
    archived: String(query.archived ?? false),
    scope: query.scope ?? "all",
    search: query.search?.trim() ?? "",
    owner_query: query.owner_query?.trim() ?? "",
    channel: query.channel ?? "",
  });
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.session_id) params.set("session_id", query.session_id);
  const scope = getAgentAccessScopeKey();
  const key = `${scope}:${params}`;
  let entry = pending.get(key);
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    const unsubscribe = subscribeChatSessionScope(() => {
      if (getAgentAccessScopeKey() !== scope) controller.abort();
    });
    const created = {
      controller,
      readers: 0,
      promise: undefined as unknown as Promise<ChatListPage>,
    };
    created.promise = request<ChatListPage>(`/chats/page?${params}`, {
      signal: controller.signal,
      headers: { "X-Agent-Id": useAgentStore.getState().selectedAgent },
    }).finally(() => {
      unsubscribe();
      if (pending.get(key) === created) pending.delete(key);
    });
    pending.set(key, created);
    entry = created;
  }
  const shared = entry;
  shared.readers++;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, page?: ChatListPage) => {
      if (done) return;
      done = true;
      signal?.removeEventListener("abort", abort);
      if (--shared.readers === 0) shared.controller.abort();
      if (error) reject(error);
      else resolve(page!);
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    shared.promise.then(
      (page) => finish(undefined, page),
      (error) => finish(error),
    );
  });
}
