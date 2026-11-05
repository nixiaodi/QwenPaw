import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chatApi } from "../api/modules/chat";
import { useChatListPages } from "./useChatListPages";
import type { ChatListPage } from "../api/types/chat";

vi.mock("../api/modules/chat", () => ({ chatApi: { listChatPage: vi.fn() } }));
vi.mock("../stores/chatSessionScope", () => ({
  getAgentAccessScopeKey: () => "user-agent",
  subscribeChatSessionScope: () => () => {},
}));
const page = (ids: string[], next: string | null = null): ChatListPage => ({
  items: ids.map((id) => ({
    id,
    session_id: id,
    user_id: "u",
    channel: "console",
    created_at: null,
    updated_at: null,
  })),
  next_cursor: next,
  has_more: next !== null,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(chatApi.listChatPage).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("loads only the first page, and coalesces repeated load-more clicks", async () => {
  let complete!: (value: ChatListPage) => void;
  vi.mocked(chatApi.listChatPage)
    .mockResolvedValueOnce(page(["a"], "next"))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
  const view = renderHook(() => useChatListPages({}, true, false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(chatApi.listChatPage).toHaveBeenCalledTimes(1);
  expect(view.result.current.items.map((x) => x.id)).toEqual(["a"]);
  let first!: Promise<void>, second!: Promise<void>;
  act(() => {
    first = view.result.current.loadMore();
    second = view.result.current.loadMore();
  });
  expect(chatApi.listChatPage).toHaveBeenCalledTimes(2);
  await act(async () => {
    complete(page(["b"]));
    await Promise.all([first, second]);
  });
  expect(view.result.current.items.map((x) => x.id)).toEqual(["a", "b"]);
  expect(view.result.current.hasMore).toBe(false);
  view.unmount();
});

it("searches the server and ignores the old query's late response", async () => {
  let old!: (value: ChatListPage) => void;
  vi.mocked(chatApi.listChatPage)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        old = resolve;
      }),
    )
    .mockResolvedValueOnce(page(["older-search-match"]));
  const view = renderHook(
    ({ search }) => useChatListPages({ search }, true, false),
    { initialProps: { search: "" } },
  );
  const signal = vi.mocked(chatApi.listChatPage).mock.calls[0][1]!;
  view.rerender({ search: "old-title" });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
    old(page(["obsolete"]));
  });
  expect(signal.aborted).toBe(true);
  expect(view.result.current.items.map((x) => x.id)).toEqual([
    "older-search-match",
  ]);
  expect(chatApi.listChatPage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      search: "old-title",
      page_size: 20,
      cursor: null,
    }),
    expect.any(AbortSignal),
  );
  view.unmount();
});

it("refreshes only loaded pages and removes revoked or deleted records", async () => {
  vi.mocked(chatApi.listChatPage)
    .mockResolvedValueOnce(page(["a"], "page2"))
    .mockResolvedValueOnce(page(["b"], "page3"))
    .mockResolvedValueOnce(page(["new-a"], "new-page2"))
    .mockResolvedValueOnce(page(["c"], "page3"));
  const view = renderHook(() => useChatListPages({}, true, false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await view.result.current.loadMore();
  });
  await act(async () => {
    await view.result.current.refresh();
  });
  expect(view.result.current.items.map((x) => x.id)).toEqual(["new-a", "c"]);
  expect(chatApi.listChatPage).toHaveBeenCalledTimes(4);
  view.unmount();
});

it("keeps the existing page on a failed continuation and allows retry", async () => {
  vi.mocked(chatApi.listChatPage)
    .mockResolvedValueOnce(page(["a"], "next"))
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(page(["b"]));
  const view = renderHook(() => useChatListPages({}, true, false));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await view.result.current.loadMore();
  });
  expect(view.result.current.error).toContain("network");
  expect(view.result.current.items).toHaveLength(1);
  await act(async () => {
    await view.result.current.retry();
  });
  expect(view.result.current.items).toHaveLength(2);
  view.unmount();
});

it("does not relabel the previous query's rows while a new query is pending", async () => {
  let complete!: (value: ChatListPage) => void;
  vi.mocked(chatApi.listChatPage)
    .mockResolvedValueOnce(page(["old"], "old-cursor"))
    .mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
  const view = renderHook(
    ({ search }) => useChatListPages({ search }, true, false),
    { initialProps: { search: "old" } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  view.rerender({ search: "new" });
  expect(view.result.current.items).toEqual([]);
  expect(view.result.current.hasMore).toBe(false);
  await act(async () => {
    complete(page(["new"]));
  });
  expect(view.result.current.items.map((item) => item.id)).toEqual(["new"]);
  view.unmount();
});
