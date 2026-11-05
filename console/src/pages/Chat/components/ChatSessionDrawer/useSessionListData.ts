import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { IAgentScopeRuntimeWebUISession } from "@agentscope-ai/chat";
import type { ChatStatus } from "../../../../api/types/chat";
import { chatApi } from "../../../../api/modules/chat";
import sessionApi from "../../sessionApi";
import { useMessageQueueStore } from "../../../../stores/messageQueueStore";
import {
  ContextMenu,
  useContextMenu,
  type ContextMenuItem,
} from "../../../../components/ContextMenu";
import { getChannelLabel } from "../../../Control/Channels/components";
import { syncSessionsGlobal } from "../../../../stores/sessionListStore";
import { useAppMessage } from "../../../../hooks/useAppMessage";
import { approvalLevelStorageKey } from "../ApprovalLevelToggle";
import { useChatListPages } from "../../../../hooks/useChatListPages";
import { areSessionListsEqual } from "../../sessionListEqual";

export { ContextMenu, useContextMenu, type ContextMenuItem, getChannelLabel };

/** Sessions from QwenPaw backend include extra fields beyond the runtime UI type */
export interface ExtendedChatSession extends IAgentScopeRuntimeWebUISession {
  realId?: string;
  sessionId?: string;
  userId?: string;
  channel?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  meta?: Record<string, unknown>;
  status?: ChatStatus;
  generating?: boolean;
  pinned?: boolean;
  archivedAt?: string | null;
  archived?: boolean;
  accessRole?: "owner" | "viewer";
  readOnly?: boolean;
  sharedBy?: string | null;
}

/** Resolve the real backend UUID from an extended session (id may be a local timestamp) */
export const getBackendId = (session: ExtendedChatSession): string | null => {
  if (session.realId) return session.realId;
  const id = session.id;
  if (/^\d+-[a-z0-9]+$/.test(id)) return null;
  return id;
};

/** Format an ISO 8601 timestamp to YYYY-MM-DD HH:mm:ss */
export const formatCreatedAt = (raw: string | null | undefined): string => {
  if (!raw) return "";
  const date = new Date(raw);
  if (isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`;
};

interface UseSessionListDataOptions {
  search?: string;
  /** Whether to start fetching (works like `open` in the drawer) */
  active: boolean;
  /** Current session id — used to determine active item and block no-op clicks */
  currentSessionId: string | undefined;
  /** Called when user clicks a session; the hook itself does NOT navigate */
  onSessionClick: (sessionId: string) => void;
  /** Called when the session list changes so the parent can sync (optional) */
  onSessionsChange?: (sessions: ExtendedChatSession[]) => void;
}

export interface SessionListData {
  hasMore: boolean;
  loadMore: () => Promise<void>;
  retry: () => Promise<void>;
  error: string;
  sortedSessions: ExtendedChatSession[];
  loading: boolean;
  /** ID of session whose switch is in flight (null = none) */
  switchingSessionId: string | null;
  editingSessionId: string | null;
  editValue: string;
  t: ReturnType<typeof useTranslation>["t"];
  handleSessionClick: (sessionId: string) => void;
  handleEditStart: (sessionId: string, currentName: string) => void;
  handleDelete: (sessionId: string) => void;
  handlePinToggle: (sessionId: string) => void;
  handleArchiveToggle: (sessionId: string) => void;
  handleEditChange: (value: string) => void;
  handleEditSubmit: () => void;
  handleEditCancel: () => void;
  handleItemContextMenu: (sessionId: string, event: React.MouseEvent) => void;
  /** Shared context-menu state */
  contextMenu: ReturnType<typeof useContextMenu>;
  contextMenuItems: ContextMenuItem[];
  refreshSessions: () => Promise<void>;
}

/**
 * Shared session-list logic extracted from ChatSessionDrawer.
 * Both ChatSessionDrawer and SidebarSessionList use this hook.
 *
 * The `onSessionClick` callback is injected by the caller so that:
 * - ChatSessionDrawer can call setCurrentSessionId directly (inside context).
 * - SidebarSessionList can dispatch a DOM event (outside context).
 */
export function useSessionListData(
  sessions: ExtendedChatSession[],
  setSessions: (s: ExtendedChatSession[]) => void,
  opts: UseSessionListDataOptions,
): SessionListData {
  const { t } = useTranslation();
  const { message } = useAppMessage();
  const { active, currentSessionId, onSessionClick } = opts;
  const page = useChatListPages(
    { search: opts.search ?? "", archived: false },
    active,
  );
  const { loading, refresh: refreshSessions } = page;
  const [switchingSessionId, setSwitchingSessionId] = useState<string | null>(
    null,
  );
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const sharedContextMenu = useContextMenu();
  const [contextMenuSessionId, setContextMenuSessionId] = useState<
    string | null
  >(null);

  /** Cache last polled sessions to skip no-op state updates */
  const lastSessionsRef = useRef<ExtendedChatSession[]>([]);

  useEffect(() => {
    lastSessionsRef.current = [];
    if (active) setSessions([]);
  }, [active, page.key, setSessions]);
  useEffect(() => {
    if (!page.loaded) return;
    const extended = sessionApi.rememberChatPage(
      page.items,
    ) as ExtendedChatSession[];
    if (!areSessionListsEqual(lastSessionsRef.current, extended)) {
      lastSessionsRef.current = extended;
      setSessions(extended);
      syncSessionsGlobal(extended);
    }
  }, [page.items, page.loaded, setSessions]);

  const resolvedSessions = useMemo(() => {
    return sessions.filter((s) => {
      const id = s.id ?? "";
      return !(/^\d+-[a-z0-9]+$/.test(id) && !s.realId);
    });
  }, [sessions]);

  const sortedSessions = useMemo(() => {
    return [...resolvedSessions]
      .filter((s) => !s.archived)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const aTime = a.updatedAt ?? a.createdAt ?? "";
        const bTime = b.updatedAt ?? b.createdAt ?? "";
        if (!aTime && !bTime) return 0;
        if (!aTime) return 1;
        if (!bTime) return -1;
        return bTime < aTime ? -1 : bTime > aTime ? 1 : 0;
      });
  }, [resolvedSessions]);

  const handleSessionClick = useCallback(
    (sessionId: string) => {
      if (sessionId === currentSessionId) return;
      setSwitchingSessionId(sessionId);
      onSessionClick(sessionId);
    },
    [currentSessionId, onSessionClick],
  );

  // Clear switchingSessionId once the URL / currentSessionId has settled
  useEffect(() => {
    setSwitchingSessionId(null);
  }, [currentSessionId]);

  // Also clear switchingSessionId when the switch completes (or fails).
  // This is needed for SidebarSessionList (simple mode) which communicates
  // via DOM events and may not see currentSessionId change on errors.
  useEffect(() => {
    const onDone = () => setSwitchingSessionId(null);
    window.addEventListener("qwenpaw:sidebar-switch-done", onDone);
    return () =>
      window.removeEventListener("qwenpaw:sidebar-switch-done", onDone);
  }, []);

  const handleDelete = useCallback(
    async (sessionId: string) => {
      const owner = sessionApi.getActiveOwner();
      const session = sessions.find((s) => s.id === sessionId);
      const backendId = session ? getBackendId(session) : null;
      if (backendId) await chatApi.deleteChat(backendId);

      // Per-session cleanup is safe regardless of the active agent: it is
      // keyed to the deleted conversation only.
      localStorage.removeItem(approvalLevelStorageKey(sessionId));

      // Clear the message queue for the deleted session so stale items don't
      // linger in storage or get sent after deletion. The queue may be keyed
      // by the local id or the resolved backend id, so clear both.
      const mq = useMessageQueueStore.getState();
      mq.clear(sessionId);
      if (backendId && backendId !== sessionId) mq.clear(backendId);

      // Everything below mutates the CURRENT view (callbacks, shared list,
      // navigation). A delete that finished after an agent switch must not
      // touch the new agent's state.
      if (!sessionApi.isActiveOwner(owner)) return;
      sessionApi.invalidateSessionAccess(backendId ?? sessionId);
      const remaining = sessions.filter((item) => item.id !== sessionId);
      setSessions(remaining);
      syncSessionsGlobal(remaining);
      await refreshSessions();
      if (!sessionApi.isActiveOwner(owner)) return;
      // A paged list cannot prove that an unrelated deep-linked chat was deleted.
      if (currentSessionId === sessionId || currentSessionId === backendId) {
        window.dispatchEvent(new CustomEvent("qwenpaw:sidebar-new-chat"));
      }
    },
    [sessions, currentSessionId, setSessions, refreshSessions],
  );

  const handleEditStart = useCallback(
    (sessionId: string, currentName: string) => {
      setEditingSessionId(sessionId);
      setEditValue(currentName);
    },
    [],
  );

  const handleEditChange = useCallback((value: string) => {
    setEditValue(value);
  }, []);

  const handleEditSubmit = useCallback(async () => {
    if (!editingSessionId) return;
    const owner = sessionApi.getActiveOwner();
    const session = sessions.find((s) => s.id === editingSessionId);
    const backendId = session ? getBackendId(session) : null;
    const newName = editValue.trim();
    if (backendId && newName) {
      await chatApi.updateChat(backendId, { name: newName });
    }
    setEditingSessionId(null);
    setEditValue("");
    if (!sessionApi.isActiveOwner(owner)) return;
    await refreshSessions();
  }, [editingSessionId, editValue, sessions, refreshSessions]);

  const handleEditCancel = useCallback(() => {
    setEditingSessionId(null);
    setEditValue("");
  }, []);

  const handlePinToggle = useCallback(
    async (sessionId: string) => {
      const owner = sessionApi.getActiveOwner();
      const session = sessions.find((s) => s.id === sessionId);
      const backendId = session ? getBackendId(session) : null;
      if (backendId && session) {
        try {
          await chatApi.updateChat(backendId, { pinned: !session.pinned });
          if (!sessionApi.isActiveOwner(owner)) return;
          await refreshSessions();
        } catch (err) {
          console.error("Failed to toggle pin status:", err);
        }
      }
    },
    [sessions, refreshSessions],
  );

  const handleArchiveToggle = useCallback(
    async (sessionId: string) => {
      const owner = sessionApi.getActiveOwner();
      const session = sessions.find((s) => s.id === sessionId);
      const backendId = session ? getBackendId(session) : null;
      if (!backendId) return;
      const wasArchived = !!session?.archived;
      try {
        if (wasArchived) {
          await chatApi.unarchiveChat(backendId);
        } else {
          await chatApi.archiveChat(backendId);
        }
        if (!sessionApi.isActiveOwner(owner)) return;
        message.success(
          wasArchived
            ? t("sessions.archive.unarchiveSuccess", "Chat unarchived")
            : t("sessions.archive.successHint"),
        );
        await refreshSessions();

        if (!wasArchived && currentSessionId) {
          const isCurrentSession =
            sessionId === currentSessionId || backendId === currentSessionId;
          if (isCurrentSession) {
            window.dispatchEvent(new CustomEvent("qwenpaw:sidebar-new-chat"));
          }
        }
      } catch (err) {
        console.error("Failed to toggle archive status:", err);
        message.error(
          t("sessions.archive.failed", "Failed to update archive status"),
        );
      }
    },
    [sessions, currentSessionId, refreshSessions, message, t],
  );

  const handleItemContextMenu = useCallback(
    (sessionId: string, event: React.MouseEvent) => {
      setContextMenuSessionId(sessionId);
      sharedContextMenu.show(event);
    },
    [sharedContextMenu],
  );

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenuSessionId) return [];
    const session = sessions.find((s) => s.id === contextMenuSessionId);
    return [
      {
        key: "open",
        label: t("chat.contextMenu.open", "Open"),
        onClick: () => handleSessionClick(contextMenuSessionId),
      },
      {
        key: "rename",
        label: t("chat.contextMenu.rename", "Rename"),
        onClick: () =>
          handleEditStart(contextMenuSessionId, session?.name || "New Chat"),
      },
      {
        key: "pin",
        label: session?.pinned
          ? t("chat.contextMenu.unpin", "Unpin")
          : t("chat.contextMenu.pin", "Pin"),
        onClick: () => handlePinToggle(contextMenuSessionId),
      },
      {
        key: "archive",
        label: session?.archived
          ? t("sessions.archive.unaction", "Unarchive")
          : t("sessions.archive.action", "Archive"),
        onClick: () => handleArchiveToggle(contextMenuSessionId),
      },
      { key: "divider-1", label: "", divider: true },
      {
        key: "delete",
        label: t("chat.contextMenu.delete", "Delete"),
        danger: true,
        onClick: () => handleDelete(contextMenuSessionId),
      },
    ];
  }, [
    contextMenuSessionId,
    sessions,
    t,
    handleSessionClick,
    handleEditStart,
    handlePinToggle,
    handleArchiveToggle,
    handleDelete,
  ]);

  return {
    hasMore: page.hasMore,
    loadMore: page.loadMore,
    retry: page.retry,
    error: page.error,
    sortedSessions,
    loading,
    switchingSessionId,
    editingSessionId,
    editValue,
    t,
    handleSessionClick,
    handleEditStart,
    handleDelete,
    handlePinToggle,
    handleArchiveToggle,
    handleEditChange,
    handleEditSubmit,
    handleEditCancel,
    handleItemContextMenu,
    contextMenu: sharedContextMenu,
    contextMenuItems,
    refreshSessions,
  };
}
