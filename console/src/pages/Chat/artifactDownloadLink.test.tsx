import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  artifactIdFromDownloadUrl,
  handleArtifactDownloadLink,
} from "./artifactDownloadLink";
import Markdown from "@agentscope-ai/chat/lib/Markdown";
import { normalizeSandboxArtifactLinks } from "./sandboxArtifactLink";

// Supply theme context omitted by the global design stub; keep Markdown and
// its link sanitizer/renderer real so unsupported protocols cannot hide bugs.
vi.mock("@agentscope-ai/chat/lib/Provider", () => ({
  useProviderContext: () => ({
    getPrefixCls: (name: string) => `test-${name}`,
  }),
  default: ({ children }: { children: React.ReactNode }) => children,
}));

const download = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const list = vi.hoisted(() => vi.fn());
vi.mock("../../api/modules/artifacts", () => ({
  artifactsApi: { download, list },
}));
beforeEach(() => {
  download.mockClear();
  list.mockReset();
});

it("downloads the normalized sandbox report through the real Markdown renderer", async () => {
  list.mockResolvedValue([
    {
      id: "report-id",
      original_name: "防水报告.pdf",
      conversation_id: "chat-a",
      status: "active",
      created_at: "2026-09-17",
    },
  ]);
  render(
    <div
      onClickCapture={(event) =>
        handleArtifactDownloadLink(event, {
          agentId: "default",
          conversationId: "chat-a",
        })
      }
    >
      <Markdown
        content={normalizeSandboxArtifactLinks(
          "[下载防水报告](sandbox:/mnt/data/防水报告.pdf)",
        )}
      />
    </div>,
  );
  fireEvent.click(await screen.findByRole("link", { name: "下载防水报告" }));
  await waitFor(() =>
    expect(download).toHaveBeenCalledWith("report-id", "防水报告.pdf", {
      agentId: "default",
    }),
  );
});

it("does not resolve sandbox links from another conversation", async () => {
  list.mockResolvedValue([
    {
      id: "foreign",
      original_name: "report.pdf",
      conversation_id: "chat-b",
      status: "active",
      created_at: "2026-09-17",
    },
  ]);
  const target = document.createElement("a");
  target.setAttribute("href", "#qwenpaw-artifact-download=report.pdf");
  handleArtifactDownloadLink(
    { target, preventDefault: vi.fn(), stopPropagation: vi.fn() },
    { agentId: "default", conversationId: "chat-a" },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(download).not.toHaveBeenCalled();
});

it("downloads a chat artifact link without navigating to an unauthenticated API page", async () => {
  let prevented = false;
  render(
    <div
      onClickCapture={(event) => {
        handleArtifactDownloadLink(event);
        prevented = event.defaultPrevented;
      }}
    >
      <a href="/api/console/artifacts/bd20d801-5fa2-4dd0-8d5e-691806601b5b/download">
        下载文档
      </a>
    </div>,
  );
  fireEvent.click(screen.getByText("下载文档"));
  await waitFor(() =>
    expect(download).toHaveBeenCalledWith(
      "bd20d801-5fa2-4dd0-8d5e-691806601b5b",
      "artifact",
    ),
  );
  expect(prevented).toBe(true);
});

it("does not send authenticated downloads to an external lookalike URL", () => {
  const event = {
    target: document.createElement("a"),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  event.target.href =
    "https://external.example/api/console/artifacts/bd20d801-5fa2-4dd0-8d5e-691806601b5b/download";
  expect(handleArtifactDownloadLink(event)).toBe(false);
  expect(download).not.toHaveBeenCalled();
  expect(event.preventDefault).not.toHaveBeenCalled();
});

it("shares the same strict artifact URL parser with file-center links", () => {
  expect(
    artifactIdFromDownloadUrl(
      "/api/console/artifacts/bd20d801-5fa2-4dd0-8d5e-691806601b5b/download",
    ),
  ).toBe("bd20d801-5fa2-4dd0-8d5e-691806601b5b");
  expect(
    artifactIdFromDownloadUrl(
      "https://external.example/api/console/artifacts/bd20d801-5fa2-4dd0-8d5e-691806601b5b/download",
    ),
  ).toBeNull();
});
