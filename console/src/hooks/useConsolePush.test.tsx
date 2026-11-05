import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useConsolePush } from "./useConsolePush";

const mock = vi.hoisted(() => ({
  get: vi.fn(),
  key: "user-a:agent-a:session-a",
  sessionId: "session-a",
  listeners: new Set<() => void>(),
}));
vi.mock("../api/modules/console", () => ({
  consoleApi: { getPushMessages: mock.get },
}));
vi.mock("../stores/chatSessionScope", () => ({
  getChatSessionScope: () => ({ key: mock.key, sessionId: mock.sessionId }),
  getChatSessionScopeKey: () => mock.key,
  subscribeChatSessionScope: (listener: () => void) => {
    mock.listeners.add(listener);
    return () => mock.listeners.delete(listener);
  },
}));
beforeEach(() => {
  vi.useFakeTimers();
  mock.get.mockReset();
  mock.key = "user-a:agent-a:session-a";
  mock.sessionId = "session-a";
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("shares one consumptive request and its result across three mounted consumers", async () => {
  let resolve!: (value: unknown) => void;
  mock.get.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const views = [
    renderHook(() => useConsolePush(true)),
    renderHook(useConsolePush),
    renderHook(useConsolePush),
  ];
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(mock.get).toHaveBeenCalledTimes(1);
  const response = {
    messages: [{ id: "once", text: "delivery" }],
    pending_approvals: [],
  };
  await act(async () => resolve(response));
  views.forEach((view) => expect(view.result.current).toEqual(response));
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(mock.get).toHaveBeenCalledTimes(2);
});

it("keeps the remaining subscriber alive and aborts when the last one leaves", () => {
  mock.get.mockReturnValue(new Promise(() => {}));
  const a = renderHook(useConsolePush),
    b = renderHook(useConsolePush);
  const signal = mock.get.mock.calls[0][1] as AbortSignal;
  a.unmount();
  expect(signal.aborted).toBe(false);
  b.unmount();
  expect(signal.aborted).toBe(true);
  expect(mock.listeners.size).toBe(0);
});

it("does not consume a session queue before a message display subscribes", () => {
  mock.get.mockReturnValue(new Promise(() => {}));
  const badge = renderHook(useConsolePush);
  expect(mock.get.mock.calls[0][0]).toBeUndefined();
  const passiveSignal = mock.get.mock.calls[0][1] as AbortSignal;
  const bubbles = renderHook(() => useConsolePush(true));
  expect(passiveSignal.aborted).toBe(true);
  expect(mock.get.mock.calls[1][0]).toBe("session-a");
  const consumerSignal = mock.get.mock.calls[1][1] as AbortSignal;
  bubbles.unmount();
  expect(consumerSignal.aborted).toBe(true);
  expect(mock.get.mock.calls[2][0]).toBeUndefined();
  badge.unmount();
});

it("retains the same snapshot when a poll has no changes", async () => {
  mock.get.mockImplementation(async () => ({
    messages: [],
    pending_approvals: [],
  }));
  const view = renderHook(useConsolePush);
  await act(async () => {});
  const first = view.result.current;
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mock.get).toHaveBeenCalledTimes(3);
  expect(view.result.current).toBe(first);
});

it("clears stale data and aborts old reads when identity or session changes", async () => {
  let oldResolve!: (value: unknown) => void;
  mock.get
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          oldResolve = done;
        }),
    )
    .mockResolvedValue({ messages: [], pending_approvals: [] });
  const view = renderHook(() => useConsolePush(true));
  const signal = mock.get.mock.calls[0][1] as AbortSignal;
  await act(async () => {
    mock.key = "user-b:agent-b:session-b";
    mock.sessionId = "session-b";
    mock.listeners.forEach((fn) => fn());
  });
  expect(signal.aborted).toBe(true);
  expect(mock.get.mock.calls[1][0]).toBe("session-b");
  await act(async () =>
    oldResolve({
      messages: [{ id: "private", text: "old" }],
      pending_approvals: [],
    }),
  );
  expect(view.result.current?.messages).toEqual([]);
});

it("backs off after errors and uses a slower hidden-tab interval", async () => {
  mock.get.mockRejectedValue(new Error("offline"));
  renderHook(useConsolePush);
  await act(() => vi.advanceTimersByTimeAsync(4999));
  expect(mock.get).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(mock.get).toHaveBeenCalledTimes(2);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(29_999));
  expect(mock.get).toHaveBeenCalledTimes(2);
});
