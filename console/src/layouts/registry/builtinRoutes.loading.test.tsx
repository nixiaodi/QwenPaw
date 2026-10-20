import { Suspense } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleRegistry } from "../../plugins/moduleRegistry";
import { BUILTIN_ROUTES } from "./builtinRoutes";

vi.mock("../../pages/Chat/route.tsx", () => ({
  default: function ChatRouteFixture() {
    const params = useParams();
    return <div>Conversation {params["*"]}</div>;
  },
}));
afterEach(cleanup);

describe("lazy chat route", () => {
  it("keeps deep links and registers the route only once visited", async () => {
    const chat = BUILTIN_ROUTES.find((route) => route.id === "core.chat")!;
    expect(moduleRegistry.getModule("Chat/route")).toBeUndefined();
    render(
      <MemoryRouter initialEntries={["/chat/local-conversation"]}>
        <Suspense fallback="Loading">
          <Routes>
            <Route path={chat.path} element={<chat.component />} />
          </Routes>
        </Suspense>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("Conversation local-conversation"),
    ).toBeInTheDocument();
    expect(moduleRegistry.getModule("Chat/route")?.default).toBeTypeOf(
      "function",
    );
  });
});
