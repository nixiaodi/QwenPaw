import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { InboxEvent } from "../api/modules/console";
import { useOsNotify } from "./osNotifyStore";

const { mockGetInboxEvents, mockGetPushMessages } = vi.hoisted(() => ({
  mockGetInboxEvents: vi.fn(),
  mockGetPushMessages: vi.fn(),
}));

vi.mock("../api", () => ({
  default: {
    getInboxEvents: mockGetInboxEvents,
    getPushMessages: mockGetPushMessages,
  },
}));
const push = { messages: [], pending_approvals: [] };
vi.mock("../hooks/useConsolePush", () => ({ useConsolePush: () => push }));
vi.mock("../stores/chatSessionScope", () => ({
  getAgentAccessScopeKey: () => "test-user",
  subscribeChatSessionScope: () => () => {},
}));

import { useOsNotifyPoller } from "./useOsNotifyPoller";

function event(id: string, sourceType: string): InboxEvent {
  return {
    id,
    agent_id: "default",
    source_type: sourceType,
    source_id: "source",
    event_type: "test",
    status: "success",
    severity: "info",
    title: id,
    body: id,
    read: false,
    created_at: 1,
  };
}

describe("useOsNotifyPoller", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it("does not overlap unread requests while the previous response is stalled", async () => {
    vi.useFakeTimers();
    mockGetInboxEvents.mockReturnValue(new Promise(() => {}));
    const view = renderHook(() => useOsNotifyPoller());
    await act(() => vi.advanceTimersByTimeAsync(36_000));
    expect(mockGetInboxEvents).toHaveBeenCalledTimes(1);
    view.unmount();
  });
  beforeEach(() => {
    mockGetInboxEvents.mockReset();
    mockGetPushMessages.mockReset();
    mockGetPushMessages.mockResolvedValue({ pending_approvals: [] });
    mockGetInboxEvents.mockResolvedValue({ events: [] });
    useOsNotify.setState({
      history: [],
      toasts: [],
      approvalCount: 0,
      inboxCount: 0,
      centerOpen: false,
      seeded: false,
      knownIds: new Set<string>(),
    });
  });

  it("uses the Inbox query limit and source filter for unread counts", async () => {
    mockGetInboxEvents.mockResolvedValue({
      unread_count: 12,
      events: [
        event("cron", "cron"),
        event("heartbeat", "heartbeat"),
        event("memory", "memory"),
        event("skill", "skill_autoupdate"),
        event("approval", "approval"),
        event("manual", "manual"),
      ],
    });

    const { unmount } = renderHook(() => useOsNotifyPoller());

    await waitFor(() => expect(useOsNotify.getState().seeded).toBe(true));
    expect(mockGetInboxEvents).toHaveBeenCalledWith(
      {
        unread_only: true,
        limit: 200,
        source_types: ["cron", "heartbeat", "memory", "skill_autoupdate"],
      },
      expect.any(AbortSignal),
    );
    expect(useOsNotify.getState().inboxCount).toBe(12);

    unmount();
  });
});
