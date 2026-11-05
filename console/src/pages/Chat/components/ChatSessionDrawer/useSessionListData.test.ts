/**
 * Regression tests for cross-agent ownership in the shared session-list CRUD
 * handlers: a delete started under agent A must not mutate the view after the
 * user switches to agent B, while same-agent CRUD keeps working.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import React from "react";
import { App } from "antd";
import { MemoryRouter } from "react-router-dom";
import type { ChatSpec } from "../../../../api";
import { asChatPage } from "../../../../test/chatPage";
import { chatApi } from "../../../../api/modules/chat";
import sessionApi from "../../sessionApi";
import { useAgentStore } from "../../../../stores/agentStore";
import { useSessionListStore } from "../../../../stores/sessionListStore";
import {
  useSessionListData,
  type ExtendedChatSession,
} from "./useSessionListData";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const A_CHAT = "33333333-aaaa-4aaa-8aaa-333333333333";

const makeSession = (id: string): ExtendedChatSession =>
  ({ id, name: id, messages: [] }) as unknown as ExtendedChatSession;

function wrapper({ children }: { children: ReactNode }) {
  return React.createElement(
    App,
    null,
    React.createElement(MemoryRouter, null, children),
  );
}

function renderListData(sessions: ExtendedChatSession[]) {
  const setSessions = vi.fn();
  const hook = renderHook(
    () =>
      useSessionListData(sessions, setSessions, {
        active: false,
        currentSessionId: A_CHAT,
        onSessionClick: vi.fn(),
      }),
    { wrapper },
  );
  return { hook, setSessions };
}

beforeEach(() => {
  sessionApi.resetForTests();
  useAgentStore.setState({ selectedAgent: "agent-a", lastChatIdByAgent: {} });
  useSessionListStore.setState({
    sessions: [],
    lastUpdated: 0,
    _setLibrarySessions: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionApi.resetForTests();
});

it("does not poll session lists in hidden tabs and refreshes on return", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  const list = vi.spyOn(chatApi, "listChatPage").mockResolvedValue(asChatPage([]));
  const setSessions = vi.fn();
  const view = renderHook(
    () =>
      useSessionListData([], setSessions, {
        active: true,
        currentSessionId: undefined,
        onSessionClick: vi.fn(),
      }),
    { wrapper },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(list).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(list).toHaveBeenCalledTimes(1);
  view.unmount();
});

it("publishes changed access metadata even when the title and timestamp are unchanged", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const original = { id: A_CHAT, name: A_CHAT, access_role: "owner", read_only: false } as ChatSpec;
  const updated = { ...original, access_role: "viewer", read_only: true, shared_by: "owner" } as ChatSpec;
  vi.spyOn(chatApi, "listChatPage")
    .mockResolvedValueOnce(asChatPage([original]))
    .mockResolvedValue(asChatPage([updated]));
  const setSessions = vi.fn();
  const view = renderHook(() => useSessionListData([], setSessions, {
    active: true, currentSessionId: A_CHAT, onSessionClick: vi.fn(),
  }), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(setSessions).toHaveBeenLastCalledWith([expect.objectContaining({ accessRole: "owner", readOnly: false })]);
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(setSessions).toHaveBeenLastCalledWith([expect.objectContaining({ accessRole: "viewer", readOnly: true, sharedBy: "owner" })]);
  view.unmount();
});

describe("useSessionListData cross-agent ownership", () => {
  it("keeps a deep-linked conversation open when another first-page chat is deleted", async () => {
    sessionApi.setActiveAgent("agent-a");
    vi.spyOn(chatApi, "deleteChat").mockResolvedValue({ success: true, chat_id: A_CHAT });
    vi.spyOn(chatApi, "listChatPage").mockResolvedValue(asChatPage([]));
    const newChat = vi.fn();
    window.addEventListener("qwenpaw:sidebar-new-chat", newChat);
    const view = renderHook(() => useSessionListData([makeSession(A_CHAT)], vi.fn(), {
      active: false, currentSessionId: "deep-outside-loaded-pages", onSessionClick: vi.fn(),
    }), { wrapper });
    await act(async () => { await view.result.current.handleDelete(A_CHAT); });
    expect(newChat).not.toHaveBeenCalled();
    view.unmount();
    window.removeEventListener("qwenpaw:sidebar-new-chat", newChat);
  });

  it("a delete finishing after an agent switch does not mutate the new view", async () => {
    sessionApi.setActiveAgent("agent-a");
    const onSessionRemoved = vi.fn();
    sessionApi.onSessionRemoved = onSessionRemoved;
    const newChatListener = vi.fn();
    window.addEventListener("qwenpaw:sidebar-new-chat", newChatListener);

    const dDelete = deferred<Awaited<ReturnType<typeof chatApi.deleteChat>>>();
    vi.spyOn(chatApi, "deleteChat").mockReturnValue(dDelete.promise);
    const listSpy = vi.spyOn(chatApi, "listChatPage").mockResolvedValue(asChatPage([]));

    const { hook, setSessions } = renderListData([makeSession(A_CHAT)]);

    act(() => {
      hook.result.current.handleDelete(A_CHAT);
    });

    // The user switches to agent B while the backend delete is in flight.
    sessionApi.setActiveAgent("agent-b");
    useSessionListStore.setState({ sessions: [makeSession("chat-b")] });

    dDelete.resolve({} as Awaited<ReturnType<typeof chatApi.deleteChat>>);
    await act(async () => {
      await new Promise((res) => setTimeout(res, 0));
    });

    // The late completion must not touch B's view or callbacks.
    expect(onSessionRemoved).not.toHaveBeenCalled();
    expect(setSessions).not.toHaveBeenCalled();
    expect(useSessionListStore.getState().sessions.map((s) => s.id)).toEqual([
      "chat-b",
    ]);
    expect(newChatListener).not.toHaveBeenCalled();
    expect(listSpy).not.toHaveBeenCalled();

    window.removeEventListener("qwenpaw:sidebar-new-chat", newChatListener);
  });

  it("a same-agent delete still refreshes the list and fires callbacks", async () => {
    sessionApi.setActiveAgent("agent-a");
    const onSessionRemoved = vi.fn();
    sessionApi.onSessionRemoved = onSessionRemoved;

    vi.spyOn(chatApi, "deleteChat").mockResolvedValue(
      {} as Awaited<ReturnType<typeof chatApi.deleteChat>>,
    );
    vi.spyOn(chatApi, "listChatPage").mockResolvedValue(asChatPage([]));

    const { hook, setSessions } = renderListData([makeSession(A_CHAT)]);

    await act(async () => {
      hook.result.current.handleDelete(A_CHAT);
      await new Promise((res) => setTimeout(res, 0));
    });

    expect(onSessionRemoved).toHaveBeenCalledWith(A_CHAT);
    expect(setSessions).toHaveBeenCalled();
  });

  it("refetches the list immediately when the selected agent changes", async () => {
    sessionApi.setActiveAgent("agent-a");
    const listSpy = vi.spyOn(chatApi, "listChatPage").mockResolvedValue(asChatPage([]));
    const setSessions = vi.fn();

    renderHook(
      () =>
        useSessionListData([], setSessions, {
          active: true,
          currentSessionId: undefined,
          onSessionClick: vi.fn(),
        }),
      { wrapper },
    );
    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(1));

    act(() => {
      useAgentStore.setState({ selectedAgent: "agent-b" });
    });

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
  });
});
