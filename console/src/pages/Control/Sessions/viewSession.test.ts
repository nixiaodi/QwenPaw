import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatApi } from "../../../api/modules/chat";
import { inspectSessionForView } from "./viewSession";

vi.mock("../../../api/modules/chat", () => ({
  chatApi: {
    getChat: vi.fn(),
    getChatSummary: vi.fn(),
  },
}));

describe("inspectSessionForView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("允许包含消息的会话进入聊天页", async () => {
    vi.mocked(chatApi.getChat).mockResolvedValue({
      messages: [{ role: "user", content: "hello" }],
      status: "idle",
    });
    vi.mocked(chatApi.getChatSummary).mockResolvedValue({ has_messages: true });

    await expect(inspectSessionForView("chat-1")).resolves.toEqual({
      kind: "chat",
    });
    expect(chatApi.getChatSummary).toHaveBeenCalledWith("chat-1");
    expect(chatApi.getChat).not.toHaveBeenCalled();
  });

  it("将只有元数据的会话识别为空会话", async () => {
    vi.mocked(chatApi.getChat).mockResolvedValue({
      messages: [],
      status: "idle",
    });
    vi.mocked(chatApi.getChatSummary).mockResolvedValue({ has_messages: false });

    await expect(inspectSessionForView("chat-2")).resolves.toEqual({
      kind: "empty",
    });
    expect(chatApi.getChatSummary).toHaveBeenCalledWith("chat-2");
    expect(chatApi.getChat).not.toHaveBeenCalled();
  });
});
