import { afterEach, expect, it, vi } from "vitest";
import {
  personalLibraryApi,
  type PersonalLibraryDocument,
} from "./personalLibrary";
import { setApiAuthMode, setAuthToken, clearAuthToken } from "../config";

afterEach(() => {
  vi.unstubAllGlobals();
  clearAuthToken();
  setApiAuthMode("legacy");
});

it("sends the trusted access token and explicit agent for page and management requests", async () => {
  setApiAuthMode("multi_user");
  setAuthToken("test-access-token");
  const fetchMock = vi
    .fn()
    .mockImplementation(async (_url, options: RequestInit) =>
      options.method === "DELETE"
        ? new Response(null, { status: 204 })
        : Response.json({ items: [], total: 0 }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const context = { agentId: "agent-a" };
  const document = {
    id: "doc-a",
    updated_at: "2026-11-07T08:00:00+08:00",
  } as PersonalLibraryDocument;
  await personalLibraryApi.listPage("采购%合同", 20, 20, context);
  await personalLibraryApi.move(document, "归档/合同.md", context);
  await personalLibraryApi.remove(document, context);
  for (const [, options] of fetchMock.mock.calls) {
    const headers = new Headers(options.headers);
    expect(headers.get("X-Agent-Id")).toBe("agent-a");
    expect(headers.get("Authorization")).toBe("Bearer test-access-token");
    expect(headers.has("X-Agent-Governance")).toBe(false);
  }
  expect(
    new URL(fetchMock.mock.calls[0][0], "http://test").searchParams.get(
      "query",
    ),
  ).toBe("采购%合同");
  expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
    destination_path: "归档/合同.md",
    expected_updated_at: document.updated_at,
  });
  expect(
    new URL(fetchMock.mock.calls[2][0], "http://test").searchParams.get(
      "expected_updated_at",
    ),
  ).toBe(document.updated_at);
});
