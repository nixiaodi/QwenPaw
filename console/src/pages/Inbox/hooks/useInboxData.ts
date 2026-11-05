import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import api from "../../../api";
import type { InboxEvent } from "../../../api/modules/console";
import { useAgentStore } from "../../../stores/agentStore";
import {
  DEFAULT_AGENT_ID,
  getAgentDisplayName,
} from "../../../utils/agentDisplayName";
import {
  INBOX_EVENT_QUERY_LIMIT,
  PUSH_MESSAGE_SOURCES,
  isPushMessageEvent,
} from "../../../utils/inboxEvents";
import type { HarvestInstance, InboxSummary, PushMessage } from "../types";
import { schedulePolling } from "../../../utils/polling";
import {
  getAgentAccessScopeKey,
  subscribeChatSessionScope,
} from "../../../stores/chatSessionScope";

const PUSH_POLLING_INTERVAL_MS = 6000;

const MOCK_HARVESTS: HarvestInstance[] = [];

const mapPriority = (text: string): "low" | "normal" | "high" | "urgent" => {
  if (text.includes("❌") || text.toLowerCase().includes("error")) {
    return "high";
  }
  return "normal";
};

const stripExecutionTimeText = (text: string): string =>
  text.replace(/\s*duration=\d+ms\.?/gi, "").trim();

const getHeartbeatSummary = (status?: string): string => {
  const normalizedStatus = (status || "").toLowerCase();
  if (normalizedStatus === "success") {
    return "Heartbeat 执行成功";
  }
  if (normalizedStatus === "timeout") {
    return "Heartbeat 执行超时";
  }
  if (normalizedStatus === "cancelled") {
    return "Heartbeat 已取消";
  }
  return "Heartbeat 执行失败";
};

const getSkillAutoUpdateSummary = (event: InboxEvent, t: TFunction): string => {
  const payload = (event.payload || {}) as {
    synced?: { skill?: string; agents?: string[] }[];
    failed?: { skill?: string; agents?: string[] }[];
  };
  const parts: string[] = [];
  for (const item of payload.synced || []) {
    parts.push(
      t("inbox.skillAutoUpdated", {
        skill: item.skill,
        agents: (item.agents || []).join(", "),
      }),
    );
  }
  for (const item of payload.failed || []) {
    parts.push(
      t("inbox.skillAutoUpdateFailed", {
        skill: item.skill,
        agents: (item.agents || []).join(", "),
      }),
    );
  }
  return parts.join("; ") || event.body;
};

const mapEventToPushMessage = (
  event: InboxEvent,
  resolveAgentName: (agentId: string) => string,
  t: TFunction,
): PushMessage => ({
  id: event.id,
  channelType:
    event.source_type === "heartbeat"
      ? "heartbeat"
      : event.source_type === "memory"
      ? "memory"
      : event.source_type === "cron"
      ? "wechat"
      : event.source_type === "skill_autoupdate"
      ? "skill"
      : "email",
  channelName:
    event.source_type === "heartbeat"
      ? "Heartbeat"
      : event.source_type === "memory"
      ? "Memory"
      : event.source_type === "cron"
      ? "Cron"
      : event.source_type === "skill_autoupdate"
      ? "Auto Sync"
      : "System",
  title:
    event.source_type === "skill_autoupdate"
      ? t("inbox.skillAutoUpdateTitle")
      : event.title,
  content:
    event.source_type === "heartbeat"
      ? getHeartbeatSummary(event.status)
      : event.source_type === "skill_autoupdate"
      ? getSkillAutoUpdateSummary(event, t)
      : stripExecutionTimeText(event.body),
  sender: {
    userId: event.agent_id || "default",
    username:
      event.source_type === "skill_autoupdate"
        ? t("inbox.skillPoolSender")
        : resolveAgentName(event.agent_id || DEFAULT_AGENT_ID),
  },
  createdAt: new Date((event.created_at || Date.now() / 1000) * 1000),
  read: Boolean(event.read),
  metadata: {
    priority:
      event.severity === "error" || event.status === "error"
        ? "high"
        : mapPriority(event.body),
    sourceType: event.source_type,
    sourceId: event.source_id,
    eventType: event.event_type,
    status: event.status,
    severity: event.severity,
    trigger:
      typeof event.payload?.trigger === "string"
        ? (event.payload.trigger as string)
        : undefined,
    agentId: event.agent_id,
    payload:
      event.payload && typeof event.payload === "object"
        ? event.payload
        : undefined,
  },
});

export const useInboxData = () => {
  const scopeKey = useSyncExternalStore(
    subscribeChatSessionScope,
    getAgentAccessScopeKey,
  );
  const control = useMemo(
    () => ({
      key: scopeKey,
      controller: new AbortController(),
      pending: null as Promise<void> | null,
      cancelRead: undefined as (() => void) | undefined,
      token: Symbol(),
      revision: 0,
      writes: 0,
    }),
    [scopeKey],
  );
  const [dataScope, setDataScope] = useState(scopeKey);
  const current = useCallback(
    () =>
      !control.controller.signal.aborted &&
      getAgentAccessScopeKey() === control.key,
    [control],
  );
  const { t } = useTranslation();
  const agents = useAgentStore((state) => state.agents);
  const agentsById = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents],
  );
  const resolveAgentName = useCallback(
    (agentId: string) => {
      const normalizedId = agentId || DEFAULT_AGENT_ID;
      const agent = agentsById.get(normalizedId);
      if (agent) {
        return getAgentDisplayName(agent, t);
      }
      if (normalizedId === DEFAULT_AGENT_ID) {
        return t("agent.defaultDisplayName");
      }
      return normalizedId;
    },
    [agentsById, t],
  );
  const resolveAgentNameRef = useRef(resolveAgentName);
  resolveAgentNameRef.current = resolveAgentName;
  const tRef = useRef(t);
  tRef.current = t;
  const [summary, setSummary] = useState<InboxSummary>({
    approvals: { total: 0, urgent: 0 },
    pushMessages: { total: 0, unread: 0 },
    harvests: {
      total: MOCK_HARVESTS.length,
      active: MOCK_HARVESTS.filter((h) => h.status === "active").length,
    },
  });
  const [pushMessages, setPushMessages] = useState<PushMessage[]>([]);
  const pushMessagesRef = useRef(pushMessages);
  pushMessagesRef.current = pushMessages;
  const [harvests] = useState<HarvestInstance[]>(MOCK_HARVESTS);

  const loadPushMessages = useCallback((): Promise<void> => {
    if (control.pending) return control.pending;
    if (!current() || control.writes > 0) return Promise.resolve();
    const revision = control.revision;
    const readController = new AbortController();
    const signal = readController.signal;
    const scopeSignal = control.controller.signal;
    const abortRead = () => readController.abort();
    scopeSignal.addEventListener("abort", abortRead, { once: true });
    control.cancelRead = abortRead;
    const token = Symbol();
    control.token = token;
    control.pending = (async () => {
      try {
        const res = await api.getInboxEvents(
          {
            limit: INBOX_EVENT_QUERY_LIMIT,
            source_types: [...PUSH_MESSAGE_SOURCES],
          },
          signal,
        );
        if (
          signal.aborted ||
          !current() ||
          revision !== control.revision ||
          control.writes > 0
        )
          return;
        const events = [...(res?.events || [])].filter(isPushMessageEvent);
        events.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        const nextItems: PushMessage[] = events.map((event) =>
          mapEventToPushMessage(
            event,
            resolveAgentNameRef.current,
            tRef.current,
          ),
        );
        setPushMessages(nextItems);
        setSummary((prev) => ({
          ...prev,
          pushMessages: {
            total: res?.total ?? nextItems.length,
            unread:
              res?.unread_count ?? nextItems.filter((m) => !m.read).length,
          },
        }));
      } finally {
        scopeSignal.removeEventListener("abort", abortRead);
        if (control.token === token) {
          control.pending = null;
          control.cancelRead = undefined;
        }
      }
    })();
    return control.pending;
  }, [control, current]);

  useEffect(() => {
    control.controller = new AbortController();
    setDataScope(scopeKey);
    setPushMessages([]);
    setSummary((prev) => ({ ...prev, pushMessages: { total: 0, unread: 0 } }));
    const stop = schedulePolling(loadPushMessages, {
      intervalMs: PUSH_POLLING_INTERVAL_MS,
    });
    return () => {
      control.controller.abort();
      control.revision += 1;
      control.pending = null;
      stop();
    };
  }, [control, loadPushMessages, scopeKey]);

  const markMessageAsRead = useCallback(
    (messageId: string) => {
      if (
        !current() ||
        !pushMessagesRef.current.some(
          (item) => item.id === messageId && !item.read,
        )
      )
        return;
      control.revision += 1;
      control.writes += 1;
      control.cancelRead?.();
      control.pending = null;
      void api
        .markInboxRead({ event_ids: [messageId] })
        .catch((error) => {
          if (current())
            console.error("Failed to mark inbox message read", error);
        })
        .finally(() => {
          control.writes -= 1;
          control.revision += 1;
        });
      setPushMessages((prev) =>
        prev.map((message) =>
          message.id === messageId ? { ...message, read: true } : message,
        ),
      );
      setSummary((prev) => ({
        ...prev,
        pushMessages: {
          ...prev.pushMessages,
          unread: Math.max(prev.pushMessages.unread - 1, 0),
        },
      }));
    },
    [control, current],
  );

  const markAllMessagesAsRead = useCallback(async (): Promise<number> => {
    const unreadIds = pushMessagesRef.current
      .filter((message) => !message.read)
      .map((m) => m.id);
    if (!unreadIds.length) {
      return 0;
    }
    if (!current()) return 0;
    control.revision += 1;
    control.writes += 1;
    control.cancelRead?.();
    control.pending = null;
    try {
      await api.markInboxRead({ all: true });
    } finally {
      control.writes -= 1;
      control.revision += 1;
    }
    if (!current()) return 0;
    setPushMessages((prev) =>
      prev.map((message) =>
        message.read ? message : { ...message, read: true },
      ),
    );
    setSummary((prev) => ({
      ...prev,
      pushMessages: {
        ...prev.pushMessages,
        unread: 0,
      },
    }));
    return unreadIds.length;
  }, [control, current]);

  const deleteMessages = useCallback(
    async (messageIds: string[]) => {
      const ids = Array.from(
        new Set(messageIds.map((id) => id.trim()).filter(Boolean)),
      );
      if (!ids.length) return 0;
      const idSet = new Set(ids);
      if (!current()) return 0;
      control.revision += 1;
      control.writes += 1;
      control.cancelRead?.();
      control.pending = null;
      let result;
      try {
        result = await api.deleteInboxEvents(ids);
      } finally {
        control.writes -= 1;
        control.revision += 1;
      }
      if (!current()) return 0;
      const deleted = result.deleted;
      if (deleted <= 0) return 0;
      if (deleted !== ids.length) {
        await loadPushMessages();
        return deleted;
      }
      const unreadDeleted = pushMessagesRef.current.filter(
        (message) => idSet.has(message.id) && !message.read,
      ).length;
      setPushMessages((prev) =>
        prev.filter((message) => !idSet.has(message.id)),
      );
      setSummary((prev) => ({
        ...prev,
        pushMessages: {
          total: Math.max(prev.pushMessages.total - deleted, 0),
          unread: Math.max(prev.pushMessages.unread - unreadDeleted, 0),
        },
      }));
      return deleted;
    },
    [loadPushMessages, control, current],
  );

  const deleteMessage = useCallback(
    (messageId: string) => {
      void deleteMessages([messageId]);
    },
    [deleteMessages],
  );

  const triggerHarvest = useCallback((harvestId: string) => {
    console.info("triggerHarvest", harvestId);
  }, []);

  const refreshPushMessages = useCallback(async () => {
    try {
      await loadPushMessages();
    } catch (error) {
      if (
        current() &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        console.error("Failed to fetch push inbox data", error);
    }
  }, [loadPushMessages, current]);

  return {
    summary:
      dataScope === scopeKey
        ? summary
        : { ...summary, pushMessages: { total: 0, unread: 0 } },
    pushMessages: dataScope === scopeKey ? pushMessages : [],
    harvests,
    markMessageAsRead,
    markAllMessagesAsRead,
    deleteMessage,
    deleteMessages,
    triggerHarvest,
    refreshPushMessages,
  };
};
