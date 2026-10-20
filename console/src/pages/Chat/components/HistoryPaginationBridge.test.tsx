import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createContext } from "use-context-selector";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import api from "../../../api";
import { ChatAnywhereMessagesContext } from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereMessagesContext";
import HistoryPaginationBridge from "./HistoryPaginationBridge";
import {
  historyPageKey,
  rememberHistoryPage,
  useHistoryPaging,
} from "../historyPaging";

vi.mock("../../../api", () => ({ default: { getChat: vi.fn() } }));
vi.mock("../sessionApi", () => ({
  default: {
    getEffectiveSessionId: (id: string) => id,
    getActiveOwner: () => ({}),
    isActiveOwner: () => true,
    invalidateConvertedCache: vi.fn(),
  },
  convertMessages: (messages: unknown[]) => messages,
}));
vi.mock(
  "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereSessionsContext",
  () => ({
    useChatAnywhereSessionsState: () => ({ currentSessionId: "chat" }),
  }),
);
vi.mock(
  "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereMessagesContext",
  () => ({ ChatAnywhereMessagesContext: createContext({}) }),
);
beforeEach(() => {
  vi.clearAllMocks();
  useHistoryPaging.setState({ pages: {} });
  rememberHistoryPage(historyPageKey("chat"), {
    messages: [],
    has_more: true,
    next_before: 20,
  });
});
afterEach(cleanup);
it("uses an exclusive cursor, prevents concurrent requests and deduplicates messages", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.getChat).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }) as never,
  );
  const setMessages = vi.fn();
  const value = { getMessages: () => [{ id: "new" }], setMessages };
  render(
    <ChatAnywhereMessagesContext.Provider value={value as never}>
      <HistoryPaginationBridge />
    </ChatAnywhereMessagesContext.Provider>,
  );
  const button = screen.getByRole("button", { name: "加载更早消息" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(api.getChat).toHaveBeenCalledTimes(1);
  expect(api.getChat).toHaveBeenCalledWith("chat", {
    signal: expect.any(AbortSignal),
    pageSize: 5,
    beforeSequence: 20,
  });
  resolve({
    messages: [{ id: "old" }, { id: "new" }],
    has_more: false,
    next_before: null,
  });
  await waitFor(() =>
    expect(setMessages).toHaveBeenCalledWith([
      { id: "old", history: true },
      { id: "new" },
    ]),
  );
  expect(screen.queryByRole("button")).toBeNull();
});
it("aborts and discards an older page when the view is closed", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api.getChat).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }) as never,
  );
  const setMessages = vi.fn();
  const view = render(
    <ChatAnywhereMessagesContext.Provider
      value={{ getMessages: () => [], setMessages } as never}
    >
      <HistoryPaginationBridge />
    </ChatAnywhereMessagesContext.Provider>,
  );
  fireEvent.click(screen.getByRole("button"));
  const signal = vi.mocked(api.getChat).mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  resolve({ messages: [{ id: "old" }], has_more: false });
  await Promise.resolve();
  expect(setMessages).not.toHaveBeenCalled();
});
