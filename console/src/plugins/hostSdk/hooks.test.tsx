import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatAnywhereSessionsContext } from "@agentscope-ai/chat/lib/AgentScopeRuntimeWebUI/core/Context/ChatAnywhereSessionsContext";
import { useHostCurrentSession } from "./hooks";

afterEach(cleanup);

function CurrentSession() {
  const session = useHostCurrentSession();
  return <div>{session?.id || "No session"}</div>;
}

describe("host session context compatibility", () => {
  it("reads and follows the SDK's existing session context", () => {
    const view = render(
      <ChatAnywhereSessionsContext.Provider
        value={{ currentSessionId: "first" } as never}
      >
        <CurrentSession />
      </ChatAnywhereSessionsContext.Provider>,
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    view.rerender(
      <ChatAnywhereSessionsContext.Provider
        value={{ currentSessionId: "second" } as never}
      >
        <CurrentSession />
      </ChatAnywhereSessionsContext.Provider>,
    );
    expect(screen.getByText("second")).toBeInTheDocument();
  });
});
