import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cancelApi = vi.fn();
const getOutputApi = vi.fn();
const getInfoApi = vi.fn();
const subscribeStream = vi.fn();
const messageError = vi.fn();
const messageSuccess = vi.fn();

vi.mock("../api/modules/toolCalls", () => ({
  toolCallsApi: {
    cancel: (...args: unknown[]) => cancelApi(...args),
    getOutput: (...args: unknown[]) => getOutputApi(...args),
    getInfo: (...args: unknown[]) => getInfoApi(...args),
  },
  subscribeToolCallStream: (...args: unknown[]) => subscribeStream(...args),
  extractOutputText: (output: { content?: Array<{ text?: string }> }) =>
    output.content?.[0]?.text || "",
}));

vi.mock("antd", () => ({
  message: {
    error: (...args: unknown[]) => messageError(...args),
    info: vi.fn(),
    success: (...args: unknown[]) => messageSuccess(...args),
  },
}));

vi.mock("../i18n", () => ({
  default: { t: (_k: string, fallback: string) => fallback },
}));

vi.mock("../utils/resolveBackendSessionId", () => ({
  resolveBackendSessionId: (preferred?: string | null) => preferred || "",
}));

import { useBackgroundTasksStore } from "../stores/backgroundTasksStore";
import {
  cancelBackgroundTask,
  registerBackgroundTask,
  stopBackgroundWatchersNotInSession,
} from "./useBackgroundTaskWatcher";

describe("useBackgroundTaskWatcher session isolation", () => {
  beforeEach(() => {
    cancelApi.mockReset();
    getOutputApi.mockReset();
    getInfoApi.mockReset();
    subscribeStream.mockReset().mockReturnValue(() => {});
    messageError.mockReset();
    messageSuccess.mockReset();
    useBackgroundTasksStore.setState({ tasks: [] });
  });

  afterEach(() => {
    stopBackgroundWatchersNotInSession("");
    vi.useRealTimers();
  });

  it("batches burst output and flushes the final text before completion", async () => {
    vi.useFakeTimers();
    getOutputApi.mockRejectedValue(new Error("output cache unavailable"));
    registerBackgroundTask({
      sessionId: "burst",
      toolCallId: "burst",
      toolName: "shell",
    });
    const updates = vi.fn();
    const unsubscribe = useBackgroundTasksStore.subscribe(updates);
    try {
      const stream = subscribeStream.mock.calls[0][2];
      for (let i = 0; i < 1000; i++) stream.onChunk({ data: `${i},` });
      expect(updates.mock.calls.length).toBeLessThanOrEqual(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(updates).toHaveBeenCalledTimes(1);
      stream.onChunk({ data: "final" });
      stream.onDone();
      await vi.advanceTimersByTimeAsync(0);
      const task = useBackgroundTasksStore.getState().tasks[0];
      expect(task.status).toBe("done");
      expect(task.result).toBe(
        Array.from({ length: 1000 }, (_, i) => `${i},`).join("") + "final",
      );
    } finally {
      unsubscribe();
    }
  });

  it("does not flush buffered output into a different session", async () => {
    vi.useFakeTimers();
    registerBackgroundTask({
      sessionId: "buffer-old",
      toolCallId: "buffer-old",
      toolName: "shell",
    });
    subscribeStream.mock.calls[0][2].onChunk({ data: "old output" });
    stopBackgroundWatchersNotInSession("");
    const updates = vi.fn();
    const unsubscribe = useBackgroundTasksStore.subscribe(updates);
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(updates).not.toHaveBeenCalled();
      expect(useBackgroundTasksStore.getState().tasks).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("bounds buffered output and preserves the tail when cancelled", async () => {
    vi.useFakeTimers();
    cancelApi.mockResolvedValue({});
    registerBackgroundTask({
      sessionId: "bounded",
      toolCallId: "bounded",
      toolName: "shell",
    });
    const stream = subscribeStream.mock.calls[0][2];
    stream.onChunk({ data: "x".repeat(120_000) });
    stream.onChunk({ data: "tail" });
    await cancelBackgroundTask("bounded", "bounded");
    const task = useBackgroundTasksStore.getState().tasks[0];
    expect(task.status).toBe("cancelled");
    expect(task.result).toBe("x".repeat(79_996) + "tail");
    stream.onChunk({ data: "late" });
    await vi.advanceTimersByTimeAsync(100);
    expect(useBackgroundTasksStore.getState().tasks[0].liveOutput).toBe(
      task.result,
    );
  });

  it("keeps background work running after a transient network failure", async () => {
    vi.useFakeTimers();
    getInfoApi.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    registerBackgroundTask({
      sessionId: "network-session",
      toolCallId: "network-tool",
      toolName: "shell",
    });
    subscribeStream.mock.calls[0][2].onError(new Error("SSE disconnected"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(useBackgroundTasksStore.getState().tasks[0].status).toBe("running");
    expect(getOutputApi).not.toHaveBeenCalled();
    getInfoApi.mockResolvedValue({ status: "offloaded" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(getInfoApi).toHaveBeenCalledTimes(2);
  });

  it("does not overlap fallback polling when the tool status endpoint is slow", async () => {
    vi.useFakeTimers();
    getInfoApi.mockReturnValue(new Promise(() => {}));
    registerBackgroundTask({
      sessionId: "slow-session",
      toolCallId: "slow-tool",
      toolName: "shell",
    });
    subscribeStream.mock.calls[0][2].onError(new Error("SSE disconnected"));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(getInfoApi).toHaveBeenCalledTimes(1);
  });

  it("ignores late stream completion after leaving the session", async () => {
    registerBackgroundTask({
      sessionId: "old-session",
      toolCallId: "old-tool",
      toolName: "shell",
    });
    stopBackgroundWatchersNotInSession("");
    subscribeStream.mock.calls[0][2].onDone();
    await Promise.resolve();
    expect(getOutputApi).not.toHaveBeenCalled();
  });

  it("finishes once when fallback polling confirms completion", async () => {
    vi.useFakeTimers();
    getInfoApi.mockResolvedValue({ status: "done", end_state: "success" });
    getOutputApi.mockResolvedValue({
      final_state: "success",
      content: [{ text: "complete" }],
    });
    registerBackgroundTask({
      sessionId: "done-session",
      toolCallId: "done-tool",
      toolName: "shell",
    });
    const handlers = subscribeStream.mock.calls[0][2];
    handlers.onError(new Error("disconnected"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(useBackgroundTasksStore.getState().tasks[0]).toMatchObject({
      status: "done",
      result: "complete",
    });
    handlers.onDone();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getInfoApi).toHaveBeenCalledTimes(1);
    expect(getOutputApi).toHaveBeenCalledTimes(1);
  });

  it("removes empty-session tasks when switching to another session", () => {
    const store = useBackgroundTasksStore.getState();
    store.addTask({
      toolCallId: "tc-a",
      toolName: "a",
      sessionId: "sid-a",
      startTime: 1,
    });
    store.addTask({
      toolCallId: "tc-empty",
      toolName: "e",
      sessionId: "",
      startTime: 2,
    });
    store.addTask({
      toolCallId: "tc-b",
      toolName: "b",
      sessionId: "sid-b",
      startTime: 3,
    });

    stopBackgroundWatchersNotInSession("sid-b");

    const left = useBackgroundTasksStore
      .getState()
      .tasks.map((t) => t.toolCallId)
      .sort();
    expect(left).toEqual(["tc-b"]);
  });

  it("refuses cancel when sessionId is empty", async () => {
    await expect(cancelBackgroundTask("", "tc-1")).rejects.toThrow(
      /Missing backend session id/,
    );
    expect(cancelApi).not.toHaveBeenCalled();
    expect(messageError).toHaveBeenCalled();
  });

  it("hydrates /output immediately when alreadyCompleted", async () => {
    getOutputApi.mockResolvedValue({
      tool_call_id: "tc-fast",
      is_closed: true,
      final_state: "success",
      content: [{ text: "fast-done" }],
    });

    registerBackgroundTask({
      sessionId: "sid-fast",
      toolCallId: "tc-fast",
      toolName: "shell",
      alreadyCompleted: true,
    });

    await vi.waitFor(() => {
      const task = useBackgroundTasksStore
        .getState()
        .tasks.find((t) => t.toolCallId === "tc-fast");
      expect(task?.status).toBe("done");
      expect(task?.result).toBe("fast-done");
    });
    expect(getOutputApi).toHaveBeenCalledWith("sid-fast", "tc-fast");
  });
});
