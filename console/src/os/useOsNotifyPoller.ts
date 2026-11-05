/** Shared approvals plus single-flight unread inbox polling for Desktop OS. */
import { useEffect, useState, useSyncExternalStore } from "react";
import api from "../api";
import { useConsolePush } from "../hooks/useConsolePush";
import {
  getAgentAccessScopeKey,
  subscribeChatSessionScope,
} from "../stores/chatSessionScope";
import { schedulePolling } from "../utils/polling";
import {
  INBOX_EVENT_QUERY_LIMIT,
  PUSH_MESSAGE_SOURCES,
  isPushMessageEvent,
} from "../utils/inboxEvents";
import { useOsNotify, type OsNotifyItem } from "./osNotifyStore";

export function useOsNotifyPoller() {
  const push = useConsolePush();
  const scope = useSyncExternalStore(
    subscribeChatSessionScope,
    getAgentAccessScopeKey,
  );
  const ingest = useOsNotify((s) => s.ingest);
  const [inbox, setInbox] = useState<{
    scope: string;
    value: Awaited<ReturnType<typeof api.getInboxEvents>>;
  } | null>(null);

  useEffect(() => {
    useOsNotify.getState().resetIdentity();
    setInbox(null);
    return schedulePolling(
      async (signal) => {
        const value = await api.getInboxEvents(
          {
            unread_only: true,
            limit: INBOX_EVENT_QUERY_LIMIT,
            source_types: [...PUSH_MESSAGE_SOURCES],
          },
          signal,
        );
        if (!signal.aborted && scope === getAgentAccessScopeKey())
          setInbox({ scope, value });
      },
      { intervalMs: 12_000 },
    );
  }, [scope]);

  useEffect(() => {
    if (!push || !inbox || inbox.scope !== scope) return;
    const approvals: OsNotifyItem[] = (push.pending_approvals || []).map(
      (a) => ({
        id: `ap:${a.request_id}`,
        kind: "approval",
        title: a.tool_display_name || a.tool_name || "Approval required",
        body: a.findings_summary || `${a.tool_name} · ${a.agent_id}`,
        createdAt: (a.created_at || Date.now() / 1000) * 1000,
        read: false,
        requestId: a.request_id,
        rootSessionId: a.root_session_id,
      }),
    );
    const events: OsNotifyItem[] = (inbox.value.events || [])
      .filter(isPushMessageEvent)
      .map((e) => ({
        id: `ib:${e.id}`,
        kind: "inbox",
        title: e.title || "Inbox message",
        body: e.body || "",
        createdAt: (e.created_at || Date.now() / 1000) * 1000,
        read: false,
      }));
    ingest(approvals, events, inbox.value.unread_count);
  }, [push, inbox, scope, ingest]);
}
