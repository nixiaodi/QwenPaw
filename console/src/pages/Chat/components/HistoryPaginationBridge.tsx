import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Button, Tooltip } from "antd";
import { useContextSelector } from "use-context-selector";
import { ChatAnywhereMessagesContext } from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereMessagesContext";
import { useChatAnywhereSessionsState } from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereSessionsContext";
import api from "../../../api";
import sessionApi, { convertMessages } from "../sessionApi";
import {
  HISTORY_PAGE_SIZE,
  historyPageKey,
  rememberHistoryPage,
  useHistoryPaging,
} from "../historyPaging";

export default function HistoryPaginationBridge() {
  const { currentSessionId } = useChatAnywhereSessionsState();
  const chatId = sessionApi.getEffectiveSessionId(currentSessionId || "");
  const key = historyPageKey(chatId);
  const page = useHistoryPaging((state) => state.pages[key]);
  const getMessages = useContextSelector(
    ChatAnywhereMessagesContext,
    (state) => state.getMessages,
  );
  const setMessages = useContextSelector(
    ChatAnywhereMessagesContext,
    (state) => state.setMessages,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeKey = useRef(key);
  activeKey.current = key;
  const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    inFlight.current = false;
    setBusy(false);
    setError("");
    return () => controller.current?.abort();
  }, [key]);
  if (!page?.hasMore || page.before === null) return null;

  const load = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    const owner = sessionApi.getActiveOwner();
    const current = new AbortController();
    controller.current = current;
    try {
      const result = await api.getChat(chatId, {
        signal: current.signal,
        pageSize: HISTORY_PAGE_SIZE,
        beforeSequence: page.before!,
      });
      if (
        current.signal.aborted ||
        activeKey.current !== key ||
        historyPageKey(chatId) !== key ||
        !sessionApi.isActiveOwner(owner)
      )
        return;
      const earlier = convertMessages(result.messages || [], false).map(
        (message) => ({ ...message, history: true }),
      );
      // The SDK scrolls to the bottom whenever its message count increases.
      // Preserve the reader's position when adding older history in reverse order.
      const scroller = document.querySelector<HTMLElement>(
        '[class*="chat-anywhere-message-list-bubble-scroll"]',
      );
      const scrollTop = scroller?.scrollTop ?? 0;
      const existing = getMessages();
      const ids = new Set(existing.map((message) => message.id));
      flushSync(() =>
        setMessages([
          ...earlier.filter((message) => !ids.has(message.id)),
          ...existing,
        ]),
      );
      if (scroller) scroller.scrollTop = scrollTop;
      sessionApi.invalidateConvertedCache(chatId);
      rememberHistoryPage(key, result);
    } catch {
      if (!current.signal.aborted && activeKey.current === key)
        setError("加载失败，请重试");
    } finally {
      if (!current.signal.aborted) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Tooltip title={error}>
      <Button loading={busy} onClick={() => void load()}>
        {error || "加载更早消息"}
      </Button>
    </Tooltip>
  );
}
