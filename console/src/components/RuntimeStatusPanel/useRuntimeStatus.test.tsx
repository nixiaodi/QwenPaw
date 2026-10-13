import { act, renderHook, cleanup, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useRuntimeStatus } from "./useRuntimeStatus";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  receive: null as
    | null
    | ((status: unknown, sid?: string, root?: string) => void),
}));
vi.mock("../../api/modules/runtimeStatus", () => ({
  runtimeStatusApi: { getCurrent: mocks.get },
  subscribeRuntimeStatusUpdates: (receive: typeof mocks.receive) => {
    mocks.receive = receive;
    return vi.fn();
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("does not resurrect failed progress when an older poll finishes after completion", async () => {
  (window as any).currentSessionId = "current";
  let resolve!: (value: unknown) => void;
  mocks.get.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const hook = renderHook(() => useRuntimeStatus(true));
  await waitFor(() => expect(mocks.receive).not.toBeNull());
  act(() => mocks.receive!(null, "current", "current"));
  await act(async () => resolve({ status: "failed", event_id: "old" }));
  expect(hook.result.current.status).toBeNull();
});
it("ignores another conversation even if only its session id is supplied", async () => {
  (window as any).currentSessionId = "current";
  mocks.get.mockResolvedValue(null);
  const hook = renderHook(() => useRuntimeStatus(true));
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  act(() => mocks.receive!({ status: "failed" }, "another"));
  expect(hook.result.current.status).toBeNull();
});
