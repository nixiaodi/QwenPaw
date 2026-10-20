import Markdown from "@agentscope-ai/chat/lib/Markdown";

export default function DefaultBlockMarkdown({ content }: { content: string }) {
  return <Markdown content={content} />;
}
