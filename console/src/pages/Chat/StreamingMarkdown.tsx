import { memo, useEffect, useRef, useState } from "react";
import { Markdown } from "@agentscope-ai/chat";
import { renderableCodeComponents } from "../../components/RenderableCodeBlock";
import type { DeliveredArtifact } from "./deliveredArtifacts";
import { normalizeSandboxArtifactLinks } from "./sandboxArtifactLink";

const LONG_ANSWER_LENGTH = 8_000;
const REFRESH_INTERVAL_MS = 100;

/** Coalesce display work only: the SDK still receives every stream event. */
function useDisplayedText(content: string, streaming: boolean) {
  const [displayed, setDisplayed] = useState(content);
  const latest = useRef(content);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const throttled = streaming && content.length >= LONG_ANSWER_LENGTH;

  useEffect(() => {
    latest.current = content;
    if (!throttled || content.length < displayed.length) {
      clearTimeout(timer.current);
      timer.current = undefined;
      setDisplayed(content);
    } else if (content !== displayed && timer.current === undefined) {
      // Keep the deadline during continuous input; a debounce would starve it.
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setDisplayed(latest.current);
      }, REFRESH_INTERVAL_MS);
    }
  }, [content, displayed, throttled]);

  useEffect(() => () => clearTimeout(timer.current), []);
  // Completion, cancellation and failure must flush in the same render.
  return !throttled || content.length < displayed.length ? content : displayed;
}

const RenderedMarkdown = memo(
  function RenderedMarkdown({
    content,
    streaming,
    delivered,
  }: {
    content: string;
    streaming: boolean;
    delivered: DeliveredArtifact[];
  }) {
    return (
      <Markdown
        components={renderableCodeComponents}
        content={normalizeSandboxArtifactLinks(content, delivered)}
        cursor={streaming}
      />
    );
  },
  (previous, next) =>
    previous.content === next.content &&
    previous.streaming === next.streaming &&
    previous.delivered.length === next.delivered.length &&
    previous.delivered.every(
      (item, index) =>
        item.name === next.delivered[index].name &&
        item.url === next.delivered[index].url,
    ),
);

export default function StreamingMarkdown({
  content,
  streaming,
  delivered,
}: {
  content: string;
  streaming: boolean;
  delivered: DeliveredArtifact[];
}) {
  const displayed = useDisplayedText(content, streaming);
  return (
    <RenderedMarkdown
      content={displayed}
      streaming={streaming}
      delivered={delivered}
    />
  );
}
