import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestChatPage } from "./chatPageRequests";
import { request } from "./request";
import { useAgentStore } from "../stores/agentStore";
import { asChatPage } from "../test/chatPage";

vi.mock("./request", () => ({ request: vi.fn() }));
beforeEach(() => {
  useAgentStore.setState({ selectedAgent: "a" });
  vi.mocked(request).mockReset();
});
afterEach(() => vi.restoreAllMocks());

it("shares concurrent first pages but lets one reader cancel independently", async () => {
  let finish!: (page: ReturnType<typeof asChatPage>) => void;
  vi.mocked(request).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const first = requestChatPage({}, controller.signal);
  const second = requestChatPage({
    archived: false,
    page_size: 20,
    scope: "all",
  });
  const rejected = expect(first).rejects.toThrow("Aborted");
  controller.abort();
  await rejected;
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.mocked(request).mock.calls[0][1]?.signal?.aborted).toBe(false);
  finish(asChatPage([]));
  expect(await second).toEqual(asChatPage([]));
});

it("cancels obsolete identity requests and separates the next agent", async () => {
  vi.mocked(request).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const previous = requestChatPage({ search: "old" });
  const rejected = expect(previous).rejects.toThrow("Aborted");
  useAgentStore.setState({ selectedAgent: "b" });
  await rejected;
  vi.mocked(request).mockResolvedValueOnce(asChatPage([]));
  await requestChatPage({ search: "old" });
  expect(request).toHaveBeenCalledTimes(2);
  expect(vi.mocked(request).mock.calls[1][1]?.headers).toEqual({
    "X-Agent-Id": "b",
  });
});

it("aborts the network request when its last reader leaves", async () => {
  vi.mocked(request).mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const controller = new AbortController();
  const pending = requestChatPage({}, controller.signal);
  const rejected = expect(pending).rejects.toThrow("Aborted");
  controller.abort();
  await rejected;
  expect(vi.mocked(request).mock.calls[0][1]?.signal?.aborted).toBe(true);
});
