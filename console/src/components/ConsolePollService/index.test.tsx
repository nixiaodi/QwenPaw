import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import ConsolePollService from ".";
import { consoleApi } from "../../api/modules/console";

const { setApprovals } = vi.hoisted(() => ({ setApprovals: vi.fn() }));
vi.mock("../../api/modules/console", () => ({
  consoleApi: { getPushMessages: vi.fn() },
}));
vi.mock("../../contexts/ApprovalContext", () => ({
  useApprovalContext: () => ({ setApprovals }),
}));
vi.mock("../../stores/chatSessionScope", () => ({
  getChatSessionScope:() => ({key:"test-user",sessionId:""}),
  getChatSessionScopeKey:() => "test-user",
  subscribeChatSessionScope:() => () => {},
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(consoleApi.getPushMessages).mockReset();
  setApprovals.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("does not pile up notification requests when one response is slow", async () => {
  vi.mocked(consoleApi.getPushMessages).mockReturnValue(new Promise(() => {}));
  render(<ConsolePollService />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(consoleApi.getPushMessages).toHaveBeenCalledTimes(1);
});

it("ignores a notification response after the view is unmounted", async () => {
  let resolve!: (
    value: Awaited<ReturnType<typeof consoleApi.getPushMessages>>,
  ) => void;
  vi.mocked(consoleApi.getPushMessages).mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const view = render(<ConsolePollService />);
  view.unmount();
  setApprovals.mockClear();
  await act(async () => {
    resolve({ messages: [], pending_approvals: [] });
  });
  expect(setApprovals).not.toHaveBeenCalled();
});
