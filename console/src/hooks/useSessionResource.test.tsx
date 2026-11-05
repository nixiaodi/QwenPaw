import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useCurrentPlan } from "../components/PlanPanel/useCurrentPlan";
import { usePendingUserInput } from "../components/UserInputPanel/usePendingUserInput";
import { useRuntimeStatus } from "../components/RuntimeStatusPanel/useRuntimeStatus";
import { publishChatSessionIdentity } from "../stores/chatSessionIdentity";
import { useAgentStore } from "../stores/agentStore";
import { clearAccessSession } from "../api/authSession";
import type { SessionStreamOptions } from "../api/sessionEventStream";

type Receiver = (
  value: unknown,
  sessionId?: string,
  rootSessionId?: string,
) => void;
const api = vi.hoisted(() => ({
  plan: vi.fn(),
  input: vi.fn(),
  status: vi.fn(),
  receivers: [] as Receiver[],
  streams: [] as SessionStreamOptions[],
  stop: vi.fn(),
}));
vi.mock("../api/modules/plan", () => ({
  planApi: { getCurrentPlan: api.plan },
  subscribePlanUpdates: (
    receive: Receiver,
    _error: unknown,
    options: SessionStreamOptions,
  ) => {
    api.receivers.push(receive);
    api.streams.push(options);
    return api.stop;
  },
}));
vi.mock("../api/modules/userInput", () => ({
  userInputApi: { getPending: api.input },
  subscribeUserInputUpdates: (
    receive: Receiver,
    _error: unknown,
    options: SessionStreamOptions,
  ) => {
    api.receivers.push(receive);
    api.streams.push(options);
    return api.stop;
  },
}));
vi.mock("../api/modules/runtimeStatus", () => ({
  runtimeStatusApi: { getCurrent: api.status },
  subscribeRuntimeStatusUpdates: (
    receive: Receiver,
    _error: unknown,
    options: SessionStreamOptions,
  ) => {
    api.receivers.push(receive);
    api.streams.push(options);
    return api.stop;
  },
}));

beforeEach(() => {
  vi.useFakeTimers();
  useAgentStore.setState({ selectedAgent: "agent-a" });
  Object.assign(window, { currentSessionId: "session-a" });
  publishChatSessionIdentity("session-a", "conversation-a");
  api.receivers.length = 0;
  api.streams.length = 0;
  api.stop.mockClear();
  [api.plan, api.input, api.status].forEach((fn) =>
    fn.mockReset().mockReturnValue(new Promise(() => {})),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps one outstanding request per active panel under slow responses", async () => {
  renderHook(() => {
    useCurrentPlan(true);
    usePendingUserInput(true);
    useRuntimeStatus(true);
  });
  await act(() => vi.advanceTimersByTimeAsync(15000));
  expect([
    api.plan.mock.calls.length,
    api.input.mock.calls.length,
    api.status.mock.calls.length,
  ]).toEqual([1, 1, 1]);
});

it("does not allow old plan/questions to overwrite a newly selected session", async () => {
  let resolvePlan!: (v: unknown) => void, resolveInput!: (v: unknown) => void;
  api.plan
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePlan = resolve;
        }),
    )
    .mockResolvedValue({ id: "new-plan" });
  api.input
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInput = resolve;
        }),
    )
    .mockResolvedValue({ request_id: "new-question", session_id: "session-b" });
  const hook = renderHook(() => ({
    plan: useCurrentPlan(true),
    input: usePendingUserInput(true),
  }));
  Object.assign(window, { currentSessionId: "session-b" });
  hook.rerender();
  await act(async () => {
    await hook.result.current.plan.refresh();
    await hook.result.current.input.refresh();
  });
  await act(async () => {
    resolvePlan({ id: "old-plan" });
    resolveInput({ request_id: "old-question", session_id: "session-a" });
  });
  expect(hook.result.current.plan.plan?.id).toBe("new-plan");
  expect(hook.result.current.input.request?.request_id).toBe("new-question");
});

it("does not resurrect a question after a newer SSE update clears it", async () => {
  let resolve!: (v: unknown) => void;
  api.input.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const hook = renderHook(() => usePendingUserInput(true));
  act(() => api.receivers[0](null, "session-a"));
  await act(async () =>
    resolve({ request_id: "old-question", session_id: "session-a" }),
  );
  expect(hook.result.current.request).toBeNull();
});

it("reacts to published session changes without a parent render and aborts old requests", async () => {
  api.plan.mockResolvedValue({ id: "new-plan" });
  const hook = renderHook(() => useCurrentPlan(true));
  const oldReceive = api.receivers[0];
  const oldSignal = api.plan.mock.calls[0][1].signal as AbortSignal;
  await act(async () => {
    Object.assign(window, { currentSessionId: "session-b" });
    publishChatSessionIdentity("session-b", "conversation-b");
  });
  expect(oldSignal.aborted).toBe(true);
  expect(api.stop).toHaveBeenCalledTimes(1);
  expect(api.plan.mock.calls[1][0]).toBe("session-b");
  act(() => oldReceive({ id: "old-plan" }, "session-a"));
  expect(hook.result.current.plan?.id).toBe("new-plan");
});

it("rejects stale events after switching away and back to the same session", async () => {
  api.plan.mockResolvedValue({ id: "current" });
  const hook = renderHook(() => useCurrentPlan(true));
  const oldReceive = api.receivers[0];
  await act(async () => {
    Object.assign(window, { currentSessionId: "session-b" });
    publishChatSessionIdentity("session-b", "conversation-b");
    Object.assign(window, { currentSessionId: "session-a" });
    publishChatSessionIdentity("session-a", "conversation-a");
  });
  act(() => oldReceive({ id: "stale" }, "session-a"));
  expect(hook.result.current.plan?.id).toBe("current");
});

it("pins the agent and replaces requests on agent and authentication changes", async () => {
  const hook = renderHook(() => useCurrentPlan(true));
  const firstSignal = api.plan.mock.calls[0][1].signal as AbortSignal;
  await act(async () => {
    useAgentStore.setState({ selectedAgent: "agent-b" });
    Object.assign(window, { currentSessionId: "session-b" });
    publishChatSessionIdentity("session-b", "conversation-b");
  });
  expect(firstSignal.aborted).toBe(true);
  expect(api.plan.mock.calls[1][1].agentId).toBe("agent-b");
  expect(api.streams[1].agentId).toBe("agent-b");
  const nextSignal = api.plan.mock.calls[1][1].signal as AbortSignal;
  await act(async () => clearAccessSession(false));
  expect(nextSignal.aborted).toBe(true);
  hook.unmount();
  expect((api.plan.mock.calls[2][1].signal as AbortSignal).aborted).toBe(true);
});

it("deduplicates manual refreshes and slows polling while the stream is connected", async () => {
  let resolve!: (value: unknown) => void;
  api.plan
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue(null);
  const hook = renderHook(() => useCurrentPlan(true));
  act(() => {
    void hook.result.current.refresh();
    void hook.result.current.refresh();
  });
  expect(api.plan).toHaveBeenCalledTimes(1);
  await act(async () => {
    api.streams[0].onConnectionChange?.(true);
    resolve(null);
  });
  await act(() => vi.advanceTimersByTimeAsync(29_999));
  expect(api.plan).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(api.plan).toHaveBeenCalledTimes(2);
  act(() => api.streams[0].onConnectionChange?.(false));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(api.plan).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(api.plan).toHaveBeenCalledTimes(4);
});

it("pauses background polling and clears disabled panel state", async () => {
  api.plan.mockResolvedValue({ id: "visible" });
  const hook = renderHook(({ active }) => useCurrentPlan(active), {
    initialProps: { active: true },
  });
  await act(async () => {});
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(api.plan).toHaveBeenCalledTimes(1);
  hidden.mockReturnValue(false);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(api.plan).toHaveBeenCalledTimes(2);
  hook.rerender({ active: false });
  expect(hook.result.current.plan).toBeNull();
  api.plan.mockReturnValue(new Promise(() => {}));
  hook.rerender({ active: true });
  expect(hook.result.current.plan).toBeNull();
});
