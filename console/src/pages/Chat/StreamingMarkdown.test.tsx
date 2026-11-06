import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StreamingMarkdown from "./StreamingMarkdown";

const rendered = vi.hoisted(() => vi.fn());
vi.mock("@agentscope-ai/chat", () => ({
  Markdown: ({ content, cursor }: { content: string; cursor: boolean }) => {
    rendered(content, cursor);
    return (
      <div data-testid="markdown" data-cursor={cursor}>
        {content}
      </div>
    );
  },
}));
vi.mock("../../components/RenderableCodeBlock", () => ({
  renderableCodeComponents: {},
}));

beforeEach(() => {
  vi.useFakeTimers();
  rendered.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("long answer display scheduling", () => {
  it("keeps displaying during continuous input while reducing expensive render calls", () => {
    let content = "正文\n".repeat(4000);
    const { rerender } = render(
      <StreamingMarkdown content={content} streaming delivered={[]} />,
    );
    for (let update = 0; update < 100; update++) {
      content += String(update);
      rerender(
        <StreamingMarkdown content={content} streaming delivered={[]} />,
      );
      act(() => {
        vi.advanceTimersByTime(10);
      });
      if (update === 49)
        expect(screen.getByTestId("markdown").textContent).toBe(content);
    }
    expect(screen.getByTestId("markdown").textContent).toBe(content);
    // Baseline: initial render + 100 incoming updates. Optimized: initial + 10 ticks.
    expect(rendered).toHaveBeenCalledTimes(11);
    rerender(
      <StreamingMarkdown
        content={content + "结束"}
        streaming={false}
        delivered={[]}
      />,
    );
    expect(screen.getByTestId("markdown").textContent).toBe(content + "结束");
    expect(screen.getByTestId("markdown")).toHaveAttribute(
      "data-cursor",
      "false",
    );
  });

  it("flushes final or cancelled text immediately and cancels stale timers", () => {
    const content = "x".repeat(9000);
    const { rerender, unmount } = render(
      <StreamingMarkdown content={content} streaming delivered={[]} />,
    );
    rerender(
      <StreamingMarkdown
        content={content + " pending"}
        streaming
        delivered={[]}
      />,
    );
    expect(screen.getByTestId("markdown").textContent).toBe(content);
    rerender(
      <StreamingMarkdown
        content={content + " final"}
        streaming={false}
        delivered={[]}
      />,
    );
    expect(screen.getByTestId("markdown").textContent).toBe(content + " final");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByTestId("markdown").textContent).toBe(content + " final");
    rerender(
      <StreamingMarkdown
        content={content + " next"}
        streaming
        delivered={[]}
      />,
    );
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renders short text immediately and does not reuse text after message replacement", () => {
    const { rerender } = render(
      <StreamingMarkdown
        key="a"
        content={"a".repeat(9000)}
        streaming
        delivered={[]}
      />,
    );
    rerender(
      <StreamingMarkdown
        key="b"
        content="另一条消息"
        streaming
        delivered={[]}
      />,
    );
    expect(screen.getByTestId("markdown").textContent).toBe("另一条消息");
    rerender(
      <StreamingMarkdown
        key="b"
        content="另一条消息，继续"
        streaming
        delivered={[]}
      />,
    );
    expect(screen.getByTestId("markdown").textContent).toBe("另一条消息，继续");
  });

  it("updates delivered file links without reparsing unchanged history on parent updates", () => {
    const content = "[下载采购报告](https://example.com/report.pdf)";
    const { rerender } = render(
      <StreamingMarkdown content={content} streaming={false} delivered={[]} />,
    );
    rerender(
      <StreamingMarkdown content={content} streaming={false} delivered={[]} />,
    );
    expect(rendered).toHaveBeenCalledTimes(1);
    rerender(
      <StreamingMarkdown
        content={content}
        streaming={false}
        delivered={[
          {
            name: "采购报告.pdf",
            url: "/api/console/artifacts/real-id/download",
          },
        ]}
      />,
    );
    expect(screen.getByTestId("markdown").textContent).toContain(
      "/api/console/artifacts/real-id/download",
    );
  });
});
