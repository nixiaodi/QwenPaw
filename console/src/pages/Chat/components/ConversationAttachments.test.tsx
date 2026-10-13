import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ConversationAttachments from "./ConversationAttachments";
const list = vi.hoisted(() => vi.fn());
vi.mock("../../../api/modules/chat", () => ({
  chatApi: { listAttachments: list },
}));
afterEach(cleanup);
it("restores the uploaded file indicator from the server when reopening a chat", async () => {
  list.mockResolvedValue([
    { id: "upload-1", original_name: "report.pdf", lifecycle: "temporary" },
  ]);
  render(
    <ConversationAttachments agentId="designer" conversationId="chat-1" />,
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "本对话文件（1）" }),
    ).toBeInTheDocument(),
  );
  expect(list).toHaveBeenCalledWith({
    conversationId: "chat-1",
    requestContext: { agentId: "designer" },
  });
});
