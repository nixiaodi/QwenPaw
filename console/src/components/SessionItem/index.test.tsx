import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/common_setup";
import i18n from "../../i18n";
import { useAgentStore } from "../../stores/agentStore";
import * as authSession from "../../api/authSession";
import SessionItem from "./index";

vi.mock("../../pages/Control/Channels/components", () => ({
  ChannelIcon: () => null,
}));
vi.mock("@agentscope-ai/icons", () => ({
  SparkMoreLine: () => <span>更多</span>,
  SparkDeleteLine: () => null,
  SparkEditLine: () => null,
  SparkMarkLine: () => null,
  SparkMarkFill: () => null,
  SparkAistorageLine: () => null,
}));
beforeEach(async () => {
  await i18n.changeLanguage("zh");
  useAgentStore.setState({ selectedAgent: "agent-a" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function requestDelete(
  variant: "sidebar" | "drawer",
  onDelete: (id: string) => void,
) {
  renderWithProviders(
    <SessionItem
      sessionId="chat-a"
      name="需要保留的会话"
      variant={variant}
      onDelete={onDelete}
    />,
  );
  fireEvent.contextMenu(screen.getByText("需要保留的会话"));
  fireEvent.click(await screen.findByRole("menuitem", { name: /删除/ }));
}

it.each(["sidebar", "drawer"] as const)(
  "%s deletion requires confirmation and cancel leaves the conversation intact",
  async (variant) => {
    const remove = vi.fn();
    await requestDelete(variant, remove);
    expect(remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("需要保留的会话");
    fireEvent.click(within(dialog).getByRole("button", { name: /取\s*消/ }));
    expect(remove).not.toHaveBeenCalled();
  },
);

it("deletes only the named conversation after confirmation", async () => {
  const remove = vi.fn();
  await requestDelete("sidebar", remove);
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: /删\s*除/ }));
  await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("chat-a"));
});

it("does not delete through a dialog opened under a previous agent", async () => {
  const remove = vi.fn();
  await requestDelete("sidebar", remove);
  const dialog = await screen.findByRole("dialog");
  useAgentStore.setState({ selectedAgent: "agent-b" });
  fireEvent.click(within(dialog).getByRole("button", { name: /删\s*除/ }));
  expect(remove).not.toHaveBeenCalled();
});

it("does not delete through a dialog opened under a previous login session", async () => {
  const remove = vi.fn();
  const generation = vi
    .spyOn(authSession, "getAccessSessionGeneration")
    .mockReturnValue(1);
  await requestDelete("sidebar", remove);
  const dialog = await screen.findByRole("dialog");
  generation.mockReturnValue(2);
  fireEvent.click(within(dialog).getByRole("button", { name: /删\s*除/ }));
  expect(remove).not.toHaveBeenCalled();
});
