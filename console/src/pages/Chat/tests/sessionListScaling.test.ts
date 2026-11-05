import { asChatPage } from "../../../test/chatPage";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import api, { type ChatSpec } from "../../../api";
import sessionApi from "../sessionApi";

function chat(id: string, sessionId = id): ChatSpec {
  return {
    id,
    session_id: sessionId,
    user_id: "member",
    channel: "console",
    name: id,
    created_at: "2026-11-01T00:00:00Z",
    updated_at: "2026-11-01T00:00:00Z",
    status: "idle",
  };
}

beforeEach(() => {
  sessionApi.resetForTests();
  sessionApi.setActiveAgent("agent-a");
});

afterEach(() => {
  vi.restoreAllMocks();
  sessionApi.resetForTests();
});

it.each([2000, 10000])(
  "refreshes %i sessions with a linear amount of identity work",
  async (size) => {
    const chats = Array.from({ length: size }, (_, i) => chat(`chat-${i}`));
    vi.spyOn(api, "listChatPage").mockResolvedValue(asChatPage(chats));
    const previous = await sessionApi.getSessionList();
    let identityReads = 0;
    for (const session of previous) {
      const id = session.id;
      Object.defineProperty(session, "id", {
        configurable: true,
        get: () => {
          identityReads++;
          return id;
        },
      });
    }
    const start = performance.now();
    const next = await sessionApi.getSessionList();
    const elapsed = performance.now() - start;
    console.info("session-list-refresh", { size, elapsed, identityReads });
    // Count work instead of asserting wall time on machines with varying load.
    expect(identityReads).toBeLessThan(size * 25);
    expect(next).toBe(previous);
    expect(next).toHaveLength(size);
  },
);

it("resolves only the newest conversation for a local placeholder", async () => {
  const draft: { id?: string } = {};
  await sessionApi.createSession(draft);
  const old = chat("older", draft.id);
  const recent = {
    ...chat("newer", draft.id),
    updated_at: "2026-11-03T00:00:00Z",
  };
  vi.spyOn(api, "listChatPage").mockResolvedValue(asChatPage([recent, old]));
  expect(await sessionApi.getSessionList()).toEqual([
    expect.objectContaining({ id: "older" }),
    expect.objectContaining({ id: draft.id, realId: "newer" }),
  ]);
  expect(sessionApi.getEffectiveSessionId(draft.id!)).toBe("newer");
  expect(await sessionApi.getSessionList()).toEqual([
    expect.objectContaining({ id: "older" }),
    expect.objectContaining({ id: draft.id, realId: "newer" }),
  ]);
});

it("publishes archive and addressing changes even without a new timestamp", async () => {
  const original = chat("stable-id");
  const list = vi.spyOn(api, "listChatPage").mockResolvedValue(asChatPage([original]));
  const first = await sessionApi.getSessionList();
  list.mockResolvedValue(asChatPage([
    {
      ...original,
      archived: true,
      archived_at: "2026-11-03T00:00:00Z",
      session_id: "corrected-session",
      user_id: "corrected-owner",
      channel: "feishu",
    },
  ]));
  const next = await sessionApi.getSessionList();
  expect(next).not.toBe(first);
  expect(next[0]).toMatchObject({
    archived: true,
    archivedAt: "2026-11-03T00:00:00Z",
    sessionId: "corrected-session",
    userId: "corrected-owner",
    channel: "feishu",
  });
});

it("opens a deep-linked UUID absent from the first page through its exact metadata", async () => {
  vi.spyOn(api, "listChatPage").mockResolvedValue(asChatPage([chat("recent")]));
  const metadata = vi.spyOn(api, "getChatSpec").mockResolvedValue(chat("older"));
  vi.spyOn(api, "getChat").mockResolvedValue({ messages: [], status: "idle" });
  await sessionApi.getSessionList();
  const opened = await sessionApi.getSession("older");
  expect(metadata).toHaveBeenCalledWith("older", undefined);
  expect(opened.name).toBe("older");
});

it("restores timestamp URLs without fetching every list page", async () => {
  const temp = "1730000000000-abc123";
  const list = vi.spyOn(api, "listChatPage").mockResolvedValue(asChatPage([chat("older", temp)]));
  const history = vi.spyOn(api, "getChat").mockResolvedValue({ messages: [], status: "idle" });
  const opened = await sessionApi.getSession(temp);
  expect(list).toHaveBeenCalledOnce();
  expect(list).toHaveBeenCalledWith({ session_id: temp, page_size: 1, archived: false });
  expect(history.mock.calls[0][0]).toBe("older");
  expect(opened.id).toBe(temp);
});
