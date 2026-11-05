import { useState } from "react";
import { useAppMessage } from "../../../hooks/useAppMessage";
import api from "../../../api";
import { chatApi } from "../../../api/modules/chat";
import type { ChatUpdateRequest, ChatListQuery } from "../../../api/types";
import type { Session } from "./components/constants";
import { useChatListPages } from "../../../hooks/useChatListPages";
import { useTranslation } from "react-i18next";

export function useSessions(
  filters: Pick<ChatListQuery, "search" | "owner_query" | "channel"> = {},
) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<"active" | "archived">("active");
  const [accessScope, setAccessScope] = useState<"all" | "owned" | "shared">(
    "all",
  );
  const { message } = useAppMessage();
  const page = useChatListPages(
    { ...filters, scope: accessScope, archived: activeTab === "archived" },
    true,
    false,
  );
  const { refresh: fetchSessions, loading } = page;
  const sessions = page.items as Session[];

  const updateSession = async (
    sessionId: string,
    values: ChatUpdateRequest,
  ) => {
    try {
      await api.updateSession(sessionId, values);
      await fetchSessions();
      message.success(t("sessions.saveSuccess"));
      return true;
    } catch (error) {
      console.error("Failed to save session:", error);
      message.error(t("sessions.saveFailed"));
      return false;
    }
  };

  const deleteSession = async (sessionId: string) => {
    try {
      await api.deleteSession(sessionId);
      await fetchSessions();
      message.success(t("sessions.deleteSuccess"));
      return true;
    } catch (error) {
      console.error("Failed to delete session:", error);
      message.error(t("sessions.deleteFailed"));
      return false;
    }
  };

  const batchDeleteSessions = async (sessionIds: string[]) => {
    try {
      await api.batchDeleteSessions(sessionIds);
      await fetchSessions();
      message.success(
        t("sessions.batchDeleteSuccess", { count: sessionIds.length }),
      );
      return true;
    } catch (error) {
      console.error("Failed to batch delete sessions:", error);
      message.error(t("sessions.batchDeleteFailed"));
      return false;
    }
  };

  const archiveSession = async (sessionId: string) => {
    try {
      await chatApi.archiveChat(sessionId);
      await fetchSessions();
      message.success(t("sessions.archive.successHint"));
      return true;
    } catch (error) {
      console.error("Failed to archive session:", error);
      message.error(t("sessions.archive.failed", "Failed to archive"));
      return false;
    }
  };

  const unarchiveSession = async (sessionId: string) => {
    try {
      await chatApi.unarchiveChat(sessionId);
      await fetchSessions();
      message.success(
        t("sessions.archive.unarchiveSuccess", "Chat unarchived"),
      );
      return true;
    } catch (error) {
      console.error("Failed to unarchive session:", error);
      message.error(
        t("sessions.archive.unarchiveFailed", "Failed to unarchive"),
      );
      return false;
    }
  };

  const batchArchiveSessions = async (sessionIds: string[]) => {
    try {
      await chatApi.batchArchiveChats(sessionIds);
      await fetchSessions();
      message.success(
        t("sessions.archive.batchSuccess", {
          count: sessionIds.length,
          defaultValue: "{{count}} chats archived",
        }),
      );
      return true;
    } catch (error) {
      console.error("Failed to batch archive sessions:", error);
      message.error(
        t("sessions.archive.batchFailed", "Failed to batch archive"),
      );
      return false;
    }
  };

  const batchUnarchiveSessions = async (sessionIds: string[]) => {
    try {
      await chatApi.batchUnarchiveChats(sessionIds);
      await fetchSessions();
      message.success(
        t("sessions.archive.batchUnarchiveSuccess", {
          count: sessionIds.length,
          defaultValue: "{{count}} chats unarchived",
        }),
      );
      return true;
    } catch (error) {
      console.error("Failed to batch unarchive sessions:", error);
      message.error(
        t("sessions.archive.batchUnarchiveFailed", "Failed to batch unarchive"),
      );
      return false;
    }
  };

  return {
    sessions,
    loading,
    updateSession,
    deleteSession,
    batchDeleteSessions,
    archiveSession,
    unarchiveSession,
    batchArchiveSessions,
    batchUnarchiveSessions,
    activeTab,
    setActiveTab,
    hasMore: page.hasMore,
    loadMore: page.loadMore,
    retry: page.retry,
    error: page.error,
    refresh: page.refresh,
    accessScope,
    setAccessScope,
  };
}
