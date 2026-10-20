import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/common_setup";
import { useAuthStore } from "@/stores/authStore";
import { agentsApi } from "@/api/modules/agents";
import AdminConversations from "./AdminConversations";
import i18n from "@/i18n";

vi.mock(
  "@agentscope-ai/chat",
  () => import("@agentscope-ai/chat/lib/index.js"),
);
vi.mock("@agentscope-ai/design", async () => ({
  ...(await vi.importActual("@agentscope-ai/design")),
  ConfigProvider: (await import("antd")).ConfigProvider,
  generateTheme: (
    await import("../../../../node_modules/@agentscope-ai/design/lib/antd/themes/generateTheme")
  ).default,
  generateThemeByToken: (
    await import("../../../../node_modules/@agentscope-ai/design/lib/antd/themes/generateThemeByToken")
  ).default,
}));

vi.mock("@/api/modules/agents", () => ({
  agentsApi: {
    listAdminAgents: vi.fn(),
    listAdminConversations: vi.fn(),
    getAdminConversation: vi.fn(),
  },
}));
beforeEach(async () => {
  await i18n.changeLanguage("zh");
  vi.clearAllMocks();
  useAuthStore.setState({
    mode: "multi_user",
    phase: "authenticated",
    user: { id: "admin", platform_role: "admin" } as never,
  });
  vi.mocked(agentsApi.listAdminAgents).mockResolvedValue({
    agents: [
      { id: "other", name: "其他用户的智能体", status: "active" },
    ] as never,
  });
  vi.mocked(agentsApi.listAdminConversations).mockResolvedValue({
    conversations: [
      {
        id: "chat-1",
        owner_name: "张三",
        owner_user_id: "user-1",
        title: "排查会话",
        status: "active",
      },
    ] as never,
  });
  vi.mocked(agentsApi.getAdminConversation).mockResolvedValue({
    read_only: true,
    history_messages: [
      {
        id: "m1",
        role: "user",
        type: "message",
        status: "completed",
        content: [{ type: "text", text: "用户的问题" }],
      },
      {
        id: "m2",
        role: "assistant",
        type: "message",
        status: "completed",
        content: [
          {
            type: "text",
            text: "## 处理结果\n\n**已完成**\n\n```python\nprint('ok')\n```\n\n| 项目 | 状态 |\n| --- | --- |\n| 检查 | 通过 |",
          },
        ],
      },
    ],
    messages: [
      {
        id: "m1",
        role: "user",
        sequence: 1,
        content: { content: [{ type: "text", text: "用户的问题" }] },
      },
    ] as never,
  });
});
afterEach(cleanup);

it("shows conversations for an Agent outside the user's store and opens read-only history", async () => {
  renderWithProviders(<AdminConversations />);
  expect(await screen.findByText("张三")).toBeInTheDocument();
  expect(agentsApi.listAdminConversations).toHaveBeenCalledWith(
    "other",
    expect.any(AbortSignal),
  );
  fireEvent.click(screen.getByRole("button", { name: "查看详情" }));
  expect(await screen.findByText("用户的问题")).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toHaveTextContent("只读");
  expect(
    screen.queryByRole("button", { name: "发送" }),
  ).not.toBeInTheDocument();
});

it("does not fetch administrator data for a member", () => {
  useAuthStore.setState({
    user: { id: "member", platform_role: "member" } as never,
  });
  renderWithProviders(<AdminConversations />);
  expect(agentsApi.listAdminAgents).not.toHaveBeenCalled();
});

it("renders the current timeline as read-only chat bubbles with Markdown", async () => {
  renderWithProviders(<AdminConversations />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  const dialog = await screen.findByRole("dialog");
  expect(
    await within(dialog).findByRole("heading", { name: "处理结果" }),
  ).toBeInTheDocument();
  expect(within(dialog).getByRole("table")).toHaveTextContent("检查");
  expect(within(dialog).getByText("已完成").tagName).toBe("STRONG");
  expect(dialog.querySelector('[data-role="user"]')).toBeInTheDocument();
  expect(dialog.querySelector('[data-role="assistant"]')).toBeInTheDocument();
  expect(within(dialog).queryByRole("textbox")).not.toBeInTheDocument();
  expect(
    within(dialog).queryByRole("button", { name: /重新生成|编辑|发送/ }),
  ).not.toBeInTheDocument();
  expect(
    within(dialog).queryByText("查看原始消息与工具数据"),
  ).not.toBeInTheDocument();
});

it("discards history that resolves after switching accounts", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(agentsApi.getAdminConversation).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }) as never,
  );
  renderWithProviders(<AdminConversations />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  act(() =>
    useAuthStore.setState({
      user: { id: "member", platform_role: "member" } as never,
    }),
  );
  await act(async () =>
    finish({ messages: [{ id: "secret", content: { text: "旧管理员消息" } }] }),
  );
  expect(screen.queryByText("旧管理员消息")).not.toBeInTheDocument();
});

it("shows tool cards and keeps replaced records behind the raw-record switch", async () => {
  vi.mocked(agentsApi.getAdminConversation).mockResolvedValueOnce({
    read_only: true,
    messages: [
      {
        id: "old",
        role: "user",
        status: "superseded",
        content: { text: "被替换的原问题" },
      },
    ] as never,
    history_messages: [
      {
        id: "question",
        role: "user",
        type: "message",
        content: [{ type: "text", text: "检查文件" }],
      },
      {
        id: "call",
        role: "assistant",
        type: "plugin_call",
        status: "completed",
        content: [
          {
            type: "data",
            data: {
              name: "read_file",
              call_id: "file-1",
              arguments: { file_path: "report.md" },
            },
          },
        ],
      },
      {
        id: "output",
        role: "tool",
        type: "plugin_call_output",
        status: "completed",
        content: [
          {
            type: "data",
            data: {
              name: "read_file",
              call_id: "file-1",
              output: "文件内容已读取",
              state: "success",
            },
          },
        ],
      },
      {
        id: "answer",
        role: "assistant",
        type: "message",
        content: [{ type: "text", text: "文件检查完成" }],
      },
    ],
  });
  renderWithProviders(<AdminConversations />);
  fireEvent.click(await screen.findByRole("button", { name: "查看详情" }));
  const dialog = await screen.findByRole("dialog");
  expect(await within(dialog).findByText(/执行 read_file/)).toBeInTheDocument();
  expect(within(dialog).getByText("文件检查完成")).toBeInTheDocument();
  expect(within(dialog).queryByText(/被替换的原问题/)).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "原始记录" }));
  expect(within(dialog).getByText(/被替换的原问题/)).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole("button", { name: "聊天视图" }));
  expect(within(dialog).queryByText(/被替换的原问题/)).not.toBeInTheDocument();
});
