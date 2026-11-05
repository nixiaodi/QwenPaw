/**
 * Tests for useInboxData hook.
 *
 * Covers:
 * - Mount loads events from getInboxEvents → pushMessages + summary counts
 * - Non cron/heartbeat source_type events are filtered out
 * - Events sorted by created_at descending
 * - Heartbeat content uses getHeartbeatSummary(status)
 * - markMessageAsRead optimistically sets read:true, decrements unread, calls api
 * - markAllMessagesAsRead returns 0 without calling api when no unread
 * - markAllMessagesAsRead marks all read, zeroes unread, returns unread count
 * - deleteMessages removes specified messages and returns count
 * - deleteMessages dedupes/trims empty ids (does not delete nothing)
 * - Polling fires getInboxEvents a second time after 6000ms
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { InboxEvent } from "../../../api/modules/console";
import { PUSH_MESSAGE_SOURCES } from "../../../utils/inboxEvents";

const {
  stableT,
  mockGetInboxEvents,
  mockMarkInboxRead,
  mockDeleteInboxEvents,
} = vi.hoisted(() => ({
  stableT: (k: string) => k,
  mockGetInboxEvents: vi.fn(),
  mockMarkInboxRead: vi.fn(),
  mockDeleteInboxEvents: vi.fn(),
}));

vi.mock("../../../api", () => ({
  default: {
    getInboxEvents: mockGetInboxEvents,
    markInboxRead: mockMarkInboxRead,
    deleteInboxEvents: mockDeleteInboxEvents,
  },
}));
const scope = vi.hoisted(() => ({
  key: "test-user",
  listeners: new Set<() => void>(),
}));
vi.mock("../../../stores/chatSessionScope", () => ({
  getAgentAccessScopeKey: () => scope.key,
  subscribeChatSessionScope: (fn: () => void) => {
    scope.listeners.add(fn);
    return () => scope.listeners.delete(fn);
  },
}));

vi.mock("../../../stores/agentStore", () => ({
  // Selector form: useAgentStore((state) => state.agents)
  useAgentStore: vi.fn((selector: (state: { agents: never[] }) => unknown) =>
    selector({ agents: [] }),
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: stableT as (k: string) => string }),
}));

vi.mock("../../../utils/agentDisplayName", () => ({
  DEFAULT_AGENT_ID: "default",
  getAgentDisplayName: vi.fn(() => "Agent"),
}));

// Imported after vi.mock so the mocks apply to its imports.
import { useInboxData } from "./useInboxData";

function makeEvent(overrides: Partial<InboxEvent> = {}): InboxEvent {
  return {
    id: "evt-1",
    agent_id: "default",
    source_type: "cron",
    source_id: "src-1",
    event_type: "cron.execution",
    status: "success",
    severity: "info",
    title: "Cron Run",
    body: "Completed duration=120ms.",
    read: false,
    created_at: 1000,
    ...overrides,
  };
}

function makeResolvedEvents(
  events: InboxEvent[],
): Promise<{ events: InboxEvent[] }> {
  return Promise.resolve({ events });
}

describe("useInboxData", () => {
  it("cancels an obsolete poll before reloading after a partial delete", async () => {
    const events = [makeEvent({ id: "a" }), makeEvent({ id: "b" })];
    mockGetInboxEvents.mockResolvedValueOnce({ events });
    const view = renderHook(() => useInboxData());
    await waitFor(() =>
      expect(view.result.current.pushMessages).toHaveLength(2),
    );
    mockGetInboxEvents
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValue({ events: [events[1]] });
    act(() => {
      void view.result.current.refreshPushMessages();
    });
    const oldSignal = mockGetInboxEvents.mock.calls[1][1] as AbortSignal;
    mockDeleteInboxEvents.mockResolvedValue({ deleted: 1 });
    await act(async () => {
      await view.result.current.deleteMessages(["a", "b"]);
    });
    expect(oldSignal.aborted).toBe(true);
    expect(view.result.current.pushMessages.map((item) => item.id)).toEqual([
      "b",
    ]);
    expect(mockGetInboxEvents).toHaveBeenCalledTimes(3);
  });
  it("keeps a single request during slow reads and repeated refresh clicks", async () => {
    vi.useFakeTimers();
    mockGetInboxEvents.mockReturnValue(new Promise(() => {}));
    const view = renderHook(() => useInboxData());
    await act(() => vi.advanceTimersByTimeAsync(18_000));
    act(() => {
      void view.result.current.refreshPushMessages();
      void view.result.current.refreshPushMessages();
    });
    expect(mockGetInboxEvents).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  beforeEach(() => {
    scope.key = "test-user";
    mockGetInboxEvents.mockReset();
    mockMarkInboxRead.mockReset();
    mockDeleteInboxEvents.mockReset();
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents([]));
    mockMarkInboxRead.mockResolvedValue({ updated: 1 });
    mockDeleteInboxEvents.mockImplementation((ids: string[]) =>
      Promise.resolve({ deleted: ids.length }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not restore unread/deleted items when an earlier poll finishes late", async () => {
    const event = makeEvent({ id: "kept" });
    mockGetInboxEvents.mockResolvedValue({
      events: [event],
      total: 1,
      unread_count: 1,
    });
    const view = renderHook(() => useInboxData());
    await waitFor(() =>
      expect(view.result.current.pushMessages).toHaveLength(1),
    );
    let resolve!: (value: unknown) => void;
    mockGetInboxEvents.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    let poll!: Promise<void>;
    act(() => {
      poll = view.result.current.refreshPushMessages();
    });
    await act(async () => view.result.current.markMessageAsRead("kept"));
    await act(async () => {
      resolve({ events: [event], total: 1, unread_count: 1 });
      await poll;
    });
    expect(view.result.current.pushMessages[0].read).toBe(true);
    expect(view.result.current.summary.pushMessages.unread).toBe(0);
    mockGetInboxEvents.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    act(() => {
      poll = view.result.current.refreshPushMessages();
    });
    await act(async () => {
      await view.result.current.deleteMessages(["kept"]);
    });
    await act(async () => {
      resolve({ events: [event], total: 1, unread_count: 1 });
      await poll;
    });
    expect(view.result.current.pushMessages).toEqual([]);
  });

  it("aborts the old identity read and ignores its late completion", async () => {
    let resolveOld!: (value: unknown) => void;
    mockGetInboxEvents
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveOld = done;
          }),
      )
      .mockResolvedValue({ events: [makeEvent({ id: "new-user" })] });
    const view = renderHook(() => useInboxData());
    const oldSignal = mockGetInboxEvents.mock.calls[0][1] as AbortSignal;
    await act(async () => {
      scope.key = "other-user";
      scope.listeners.forEach((fn) => fn());
    });
    expect(oldSignal.aborted).toBe(true);
    await act(async () =>
      resolveOld({ events: [makeEvent({ id: "old-user" })] }),
    );
    expect(view.result.current.pushMessages.map((item) => item.id)).toEqual([
      "new-user",
    ]);
    mockGetInboxEvents.mockReturnValueOnce(new Promise(() => {}));
    act(() => {
      void view.result.current.refreshPushMessages();
    });
    view.unmount();
    expect((mockGetInboxEvents.mock.calls[2][1] as AbortSignal).aborted).toBe(
      true,
    );
  });

  it("pauses polling while hidden and resumes once visible", async () => {
    vi.useFakeTimers();
    const view = renderHook(() => useInboxData());
    await act(async () => {});
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mockGetInboxEvents).toHaveBeenCalledTimes(1);
    hidden.mockReturnValue(false);
    await act(async () =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
    expect(mockGetInboxEvents).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("mount loads events and sets pushMessages + summary counts", async () => {
    const events = [
      makeEvent({ id: "a", read: false }),
      makeEvent({ id: "b", read: true }),
    ];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(2));

    expect(mockGetInboxEvents).toHaveBeenCalledWith(
      {
        limit: 200,
        source_types: [...PUSH_MESSAGE_SOURCES],
      },
      expect.any(AbortSignal),
    );
    expect(result.current.summary.pushMessages.total).toBe(2);
    expect(result.current.summary.pushMessages.unread).toBe(1);
  });

  it("filters out events whose source_type is not cron or heartbeat", async () => {
    const events = [
      makeEvent({ id: "keep-cron", source_type: "cron" }),
      makeEvent({ id: "keep-heartbeat", source_type: "heartbeat" }),
      makeEvent({ id: "drop-manual", source_type: "manual" }),
      makeEvent({ id: "drop-approval", source_type: "approval" }),
    ];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(2));
    const ids = result.current.pushMessages.map((m) => m.id);
    expect(ids).toEqual(["keep-cron", "keep-heartbeat"]);
    expect(result.current.summary.pushMessages.total).toBe(2);
  });

  it("sorts events by created_at descending", async () => {
    const events = [
      makeEvent({ id: "old", created_at: 1000 }),
      makeEvent({ id: "new", created_at: 5000 }),
      makeEvent({ id: "mid", created_at: 3000 }),
    ];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(3));
    const ids = result.current.pushMessages.map((m) => m.id);
    expect(ids).toEqual(["new", "mid", "old"]);
  });

  it('maps heartbeat content via getHeartbeatSummary(status="success")', async () => {
    const events = [
      makeEvent({
        id: "hb-1",
        source_type: "heartbeat",
        status: "success",
        body: "should not be used",
      }),
    ];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(1));
    const msg = result.current.pushMessages[0];
    expect(msg.channelType).toBe("heartbeat");
    expect(msg.content).toBe("Heartbeat 执行成功");
  });

  it("markMessageAsRead optimistically marks read and decrements unread", async () => {
    const events = [makeEvent({ id: "m1", read: false })];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(1));
    expect(result.current.summary.pushMessages.unread).toBe(1);

    act(() => {
      result.current.markMessageAsRead("m1");
    });

    expect(mockMarkInboxRead).toHaveBeenCalledWith({ event_ids: ["m1"] });
    expect(result.current.pushMessages[0].read).toBe(true);
    expect(result.current.summary.pushMessages.unread).toBe(0);
  });

  it("markAllMessagesAsRead returns 0 without calling api when no unread", async () => {
    const events = [makeEvent({ id: "m1", read: true })];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(1));

    let count = -1;
    await act(async () => {
      count = await result.current.markAllMessagesAsRead();
    });

    expect(count).toBe(0);
    expect(mockMarkInboxRead).not.toHaveBeenCalled();
  });

  it("markAllMessagesAsRead marks all read, zeroes unread, returns unread count", async () => {
    const events = [
      makeEvent({ id: "m1", read: false }),
      makeEvent({ id: "m2", read: false }),
      makeEvent({ id: "m3", read: true }),
    ];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => {
      expect(result.current.summary.pushMessages.unread).toBe(2);
    });

    let count = -1;
    await act(async () => {
      count = await result.current.markAllMessagesAsRead();
    });

    expect(count).toBe(2);
    expect(mockMarkInboxRead).toHaveBeenCalledWith({ all: true });
    expect(result.current.pushMessages.every((m) => m.read === true)).toBe(
      true,
    );
    expect(result.current.summary.pushMessages.unread).toBe(0);
  });

  it("deleteMessages removes specified messages and returns count", async () => {
    const events = [
      makeEvent({ id: "m1", read: false }),
      makeEvent({ id: "m2", read: true }),
      makeEvent({ id: "m3", read: false }),
    ];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(3));

    let returnedCount = -1;
    await act(async () => {
      returnedCount = await result.current.deleteMessages(["m1", "m3"]);
    });

    expect(returnedCount).toBe(2);
    expect(mockDeleteInboxEvents).toHaveBeenCalledTimes(1);
    expect(mockDeleteInboxEvents).toHaveBeenCalledWith(["m1", "m3"]);
    expect(result.current.pushMessages.map((m) => m.id)).toEqual(["m2"]);
    expect(result.current.pushMessages).toHaveLength(1);
  });

  it("deleteMessages trims/dedupes empty ids and deletes nothing when only empty", async () => {
    const events = [makeEvent({ id: "m1", read: false })];
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents(events));

    const { result } = renderHook(() => useInboxData());

    await waitFor(() => expect(result.current.pushMessages).toHaveLength(1));

    let deleted = -1;
    await act(async () => {
      deleted = await result.current.deleteMessages(["", "  ", ""]);
    });

    expect(deleted).toBe(0);
    expect(mockDeleteInboxEvents).not.toHaveBeenCalled();
    expect(result.current.pushMessages).toHaveLength(1);
  });

  it("polls getInboxEvents a second time after 6000ms", async () => {
    vi.useFakeTimers();
    mockGetInboxEvents.mockResolvedValue(makeResolvedEvents([]));

    renderHook(() => useInboxData());

    // Initial mount call flushes synchronously via microtask; advance macrotasks
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockGetInboxEvents).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });

    expect(mockGetInboxEvents).toHaveBeenCalledTimes(2);
  });
});
