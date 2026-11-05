import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { chatApi } from "../api/modules/chat";
import type { ChatListQuery, ChatSpec } from "../api/types/chat";
import {
  getAgentAccessScopeKey,
  subscribeChatSessionScope,
} from "../stores/chatSessionScope";
import { schedulePolling } from "../utils/polling";

const EMPTY: ChatSpec[] = [];

/** Only pages the user requested are refreshed. Search always starts at the server. */
export function useChatListPages(
  query: ChatListQuery,
  active = true,
  poll = true,
) {
  const scope = useSyncExternalStore(
    subscribeChatSessionScope,
    getAgentAccessScopeKey,
  );
  const queryKey = JSON.stringify(query);
  const control = useMemo(
    () => ({
      scope,
      query: JSON.parse(queryKey) as ChatListQuery,
      controller: new AbortController(),
      pending: null as Promise<void> | null,
      items: EMPTY,
      pages: 1,
      next: null as string | null,
      hasMore: false,
      revision: 0,
      ready: false,
      retryMore: false,
    }),
    [scope, queryKey],
  );
  const [state, setState] = useState({
    control,
    items: EMPTY,
    loading: active,
    hasMore: false,
    error: "",
  });
  const run = useCallback(
    (more = false, force = false): Promise<void> => {
      if (control.pending && !force) return control.pending;
      if (more && (!control.ready || !control.hasMore))
        return Promise.resolve();
      if (force) {
        control.controller.abort();
        control.controller = new AbortController();
      }
      const revision = ++control.revision;
      const signal = control.controller.signal;
      const valid = () =>
        !signal.aborted &&
        control.scope === getAgentAccessScopeKey() &&
        revision === control.revision;
      if (!valid()) return Promise.resolve();
      setState((old) => ({
        control,
        loading: true,
        error: "",
        items: old.control === control ? old.items : EMPTY,
        hasMore: old.control === control && old.hasMore,
      }));
      const pending = (async () => {
        try {
          let cursor = more ? control.next : null;
          const combined = more ? [...control.items] : [];
          let hasMore = false;
          let pages = more ? control.pages : 0;
          for (let i = 0; i < (more ? 1 : control.pages); i++) {
            const page = await chatApi.listChatPage(
              { ...control.query, cursor, page_size: 20 },
              signal,
            );
            if (!valid()) return;
            combined.push(...page.items);
            pages++;
            cursor = page.next_cursor;
            hasMore = page.has_more && Boolean(cursor);
            if (!hasMore) break;
          }
          if (!valid()) return;
          const items = [
            ...new Map(combined.map((item) => [item.id, item])).values(),
          ];
          Object.assign(control, {
            items,
            pages,
            next: cursor,
            hasMore,
            ready: true,
          });
          setState({ control, items, loading: false, hasMore, error: "" });
        } catch (error) {
          if (valid()) control.retryMore = more;
          if (valid())
            setState((old) => ({
              ...old,
              control,
              loading: false,
              error: String(error),
            }));
          throw error;
        } finally {
          if (revision === control.revision) control.pending = null;
        }
      })();
      control.pending = pending;
      return pending;
    },
    [control],
  );
  useEffect(() => {
    if (!active) return;
    control.controller = new AbortController();
    if (!poll) void run().catch(() => {});
    const stop = poll
      ? schedulePolling(() => run(), { intervalMs: 3000 })
      : () => {};
    return () => {
      stop();
      control.controller.abort();
      control.revision++;
      control.pending = null;
    };
  }, [active, control, poll, run]);
  const loadMore = useCallback(() => run(true).catch(() => {}), [run]);
  const refresh = useCallback(() => run(false, true).catch(() => {}), [run]);
  const retry = useCallback(
    () => run(control.retryMore, true).catch(() => {}),
    [control, run],
  );
  return {
    key: `${scope}:${queryKey}`,
    loaded: control.ready,
    items: state.control === control ? state.items : EMPTY,
    loading: state.control === control ? state.loading : active,
    hasMore: state.control === control && state.hasMore,
    error: state.control === control ? state.error : "",
    loadMore,
    refresh,
    retry,
  };
}
