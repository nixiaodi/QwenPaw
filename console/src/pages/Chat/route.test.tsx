import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import ChatRoute from "./route";

const state = vi.hoisted(() => ({
  pathname: "/chat/first",
  navigationState: null as { chatAgentId: string } | null,
  selectedAgent: "a",
  agents: [{ id: "a" }, { id: "b" }],
  renderedAgents: [] as string[],
  listChats: vi.fn(),
  navigate: vi.fn(),
  getLastChatId: vi.fn((): string | undefined => undefined),
  setSelectedAgent: vi.fn((id: string) => {
    state.selectedAgent = id;
  }),
}));

vi.mock("react-router-dom", () => ({
  useLocation: () => ({
    pathname: state.pathname,
    state: state.navigationState,
  }),
  useNavigate: () => state.navigate,
}));
vi.mock("antd", () => ({ Spin: () => <div data-testid="resolving" /> }));
vi.mock("../../stores/authStore", () => ({ useAuthStore: () => "multi_user" }));
vi.mock("../../stores/agentStore", () => ({ useAgentStore: () => state }));
vi.mock("../../api/modules/chat", () => ({
  chatApi: { listChats: state.listChats },
}));
vi.mock("./index", () => ({
  default: () => {
    state.renderedAgents.push(state.selectedAgent);
    return <div data-testid="chat" />;
  },
}));
vi.mock("./sessionApi", () => ({
  default: {
    hasResolvedSessionForAgent: vi.fn(() => false),
    resetWindowIdentity: vi.fn(),
    lastActiveChatId: null,
    preferredChatId: null,
  },
}));

beforeEach(() => {
  cleanup();
  state.pathname = "/chat/first";
  state.navigationState = null;
  state.selectedAgent = "a";
  state.renderedAgents = [];
  vi.clearAllMocks();
  state.getLastChatId.mockReset().mockReturnValue(undefined);
  state.listChats.mockImplementation(
    async ({ requestContext }: { requestContext: { agentId: string } }) =>
      requestContext.agentId === "a" ? [{ id: "first" }] : [{ id: "second" }],
  );
});

describe("ChatRoute", () => {
  it("blocks the old chat while switching to a different agent", async () => {
    const view = render(<ChatRoute />);
    await waitFor(() => expect(screen.queryByTestId("chat")).not.toBeNull());
    state.selectedAgent = "b";
    view.rerender(<ChatRoute />);
    expect(screen.queryByTestId("chat")).toBeNull();
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith(
        "/chat",
        expect.objectContaining({ replace: true }),
      ),
    );
  });

  it("keeps the selected agent when returning from skills with a foreign saved chat", async () => {
    state.selectedAgent = "b";
    state.navigationState = { chatAgentId: "b" };
    render(<ChatRoute />);
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith(
        "/chat",
        expect.objectContaining({ replace: true }),
      ),
    );
    expect(state.selectedAgent).toBe("b");
    expect(state.renderedAgents).toEqual([]);
  });

  it("restores only an accessible chat for the newly selected agent", async () => {
    const view = render(<ChatRoute />);
    await waitFor(() => expect(screen.queryByTestId("chat")).not.toBeNull());
    state.getLastChatId.mockReturnValueOnce("second");
    state.selectedAgent = "b";
    view.rerender(<ChatRoute />);
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith(
        "/chat/second",
        expect.objectContaining({ replace: true }),
      ),
    );
  });

  it("does not restore a foreign chat saved under the new agent", async () => {
    const view = render(<ChatRoute />);
    await waitFor(() => expect(screen.queryByTestId("chat")).not.toBeNull());
    state.getLastChatId.mockReturnValue("first");
    state.selectedAgent = "b";
    view.rerender(<ChatRoute />);
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith(
        "/chat",
        expect.objectContaining({ replace: true }),
      ),
    );
    expect(state.selectedAgent).toBe("b");
  });

  it("does not let an earlier sidebar navigation undo a subsequent agent switch", async () => {
    state.navigationState = { chatAgentId: "a" };
    const view = render(<ChatRoute />);
    await waitFor(() => expect(screen.queryByTestId("chat")).not.toBeNull());
    state.selectedAgent = "b";
    view.rerender(<ChatRoute />);
    await waitFor(() =>
      expect(state.navigate).toHaveBeenCalledWith(
        "/chat",
        expect.objectContaining({ replace: true }),
      ),
    );
    expect(state.selectedAgent).toBe("b");
  });

  it("rejects a late restore result after another agent selection", async () => {
    const view = render(<ChatRoute />);
    await waitFor(() => expect(screen.queryByTestId("chat")).not.toBeNull());
    let finish: (chats: { id: string }[]) => void = () => {};
    state.listChats.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    state.selectedAgent = "b";
    view.rerender(<ChatRoute />);
    state.selectedAgent = "a";
    view.rerender(<ChatRoute />);
    await act(async () => finish([{ id: "second" }]));
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.selectedAgent).toBe("a");
  });

  it("shows a lookup failure without changing the selected agent or creating a chat", async () => {
    state.selectedAgent = "b";
    state.navigationState = { chatAgentId: "b" };
    state.listChats.mockRejectedValue(new Error("network unavailable"));
    render(<ChatRoute />);
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeNull());
    expect(state.selectedAgent).toBe("b");
    expect(state.navigate).not.toHaveBeenCalled();
    expect(state.renderedAgents).toEqual([]);
  });

  it("does not mount a new deep-linked chat under the previous agent", async () => {
    const view = render(<ChatRoute />);
    await waitFor(() => expect(screen.queryByTestId("chat")).not.toBeNull());
    state.renderedAgents = [];
    let finish: (chats: { id: string }[]) => void = () => {};
    state.listChats.mockImplementation(
      ({ requestContext }: { requestContext: { agentId: string } }) =>
        requestContext.agentId === "a"
          ? Promise.resolve([])
          : new Promise((resolve) => {
              finish = resolve;
            }),
    );
    state.pathname = "/chat/second";
    view.rerender(<ChatRoute />);
    expect(screen.queryByTestId("chat")).toBeNull();
    expect(state.renderedAgents).toEqual([]);
    await act(async () => finish([{ id: "second" }]));
    await waitFor(() => expect(screen.queryByTestId("chat")).not.toBeNull());
    expect(state.renderedAgents).toEqual(["b"]);
  });
});
