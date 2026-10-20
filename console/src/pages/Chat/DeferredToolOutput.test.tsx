import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { request } from "../../api/request";
import DeferredToolOutput from "./DeferredToolOutput";

vi.mock("../../api/request", () => ({ request: vi.fn() }));
vi.mock(
  "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/AgentScopeRuntime/Response/Tool",
  () => ({
    default: ({ data }: { data: unknown }) => <div>{JSON.stringify(data)}</div>,
  }),
);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const data = {
  id: "call",
  type: "plugin_call",
  content: [
    {
      type: "data",
      data: { name: "shell", call_id: "c1", arguments: { command: "ls" } },
    },
    {
      type: "data",
      data: {
        name: "shell",
        call_id: "c1",
        output: "摘要",
        qwenpaw_output_ref: {
          path: "/chats/chat/messages/output/tool-output",
          byte_size: 200000,
        },
      },
    },
  ],
};
it("fetches a large tool output only on demand and preserves its call arguments", async () => {
  vi.mocked(request).mockResolvedValue({
    content: [
      {
        type: "data",
        data: { name: "shell", call_id: "c1", output: "完整输出" },
      },
    ],
  });
  render(<DeferredToolOutput data={data as never} />);
  expect(request).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /加载完整输出/ }));
  await waitFor(() =>
    expect(screen.getByText(/完整输出/)).toHaveTextContent("command"),
  );
  expect(request).toHaveBeenCalledTimes(1);
});
it("does not render a response after its conversation unmounts", async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(request).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const view = render(<DeferredToolOutput data={data as never} />);
  fireEvent.click(screen.getByRole("button", { name: /加载完整输出/ }));
  view.unmount();
  resolve({ content: [] });
  expect(screen.queryByText(/command/)).toBeNull();
});

it("keeps the summary available and supports retry after a failed full-output response", async () => {
  vi.mocked(request).mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ content: [{type:"data",data:{name:"shell",call_id:"c1",output:"重试成功"}}] });
  render(<DeferredToolOutput data={data as never} />);
  fireEvent.click(screen.getByRole("button", {name:/加载完整输出/}));
  const retry = await screen.findByRole("button", {name:/重试加载完整输出/});
  expect(screen.getByText(/摘要/)).toBeInTheDocument();
  fireEvent.click(retry);
  await waitFor(() => expect(screen.getByText(/重试成功/)).toBeInTheDocument());
  expect(request).toHaveBeenCalledTimes(2);
});
