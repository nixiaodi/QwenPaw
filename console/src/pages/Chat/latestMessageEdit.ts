import type { IAgentScopeRuntimeWebUIInputData } from "@agentscope-ai/chat";
import type { Message } from "../../api/types/chat";

export type EditRequestData = {
  input?: Array<Record<string, unknown>>;
  created_at?: number;
};

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((part) => part.type === "text")
        .map((part) => part.text || "")
        .join("\n")
    : "";
}

export function requestText(data: EditRequestData): string {
  return (data.input || [])
    .map((input) => contentText(input.content))
    .join("\n");
}

export function editedRequestContent(
  content: unknown,
  text: string,
): Array<Record<string, unknown>> {
  return [
    { type: "text", text },
    ...(Array.isArray(content)
      ? content
          .filter((part) => part.type !== "text")
          .map((part) => ({ ...part }))
      : []),
  ];
}

export function editedRequestFileList(
  content: Array<Record<string, unknown>>,
): NonNullable<IAgentScopeRuntimeWebUIInputData["fileList"]> {
  const media = {
    image: { url: "image_url", mime: "image/png" },
    video: { url: "video_url", mime: "video/mp4" },
    audio: { url: "audio_url", mime: "audio/mpeg" },
    file: { url: "file_url", mime: "application/octet-stream" },
  };
  return content.flatMap((part) => {
    const kind = part.type as keyof typeof media;
    const format = media[kind];
    const url = format && (part[format.url] || (kind === "audio" && part.data));
    if (typeof url !== "string" || !url) return [];
    return [
      {
        uid: url,
        name: String(
          part.file_name ||
            part.filename ||
            part.fileName ||
            url.split("/").pop() ||
            kind,
        ),
        type: format.mime,
        size: typeof part.file_size === "number" ? part.file_size : undefined,
        file_id: typeof part.file_id === "string" ? part.file_id : undefined,
        url,
        status: "done" as const,
        response: { url },
        thumbUrl: kind === "image" ? url : undefined,
      },
    ];
  });
}

export function clientMessageId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const nested =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : record;
  return typeof nested.qwenpaw_client_message_id === "string"
    ? nested.qwenpaw_client_message_id
    : undefined;
}

export function editFailureKey(status: number, detail: unknown): string {
  if (detail === "edit_run_unavailable") return "chat.editRunUnavailable";
  if (detail === "turn_context_unavailable")
    return "chat.editContextUnavailable";
  return status === 409 &&
    ["latest_message_changed", "edit_request_conflict"].includes(String(detail))
    ? "chat.editConflict"
    : "chat.editFailed";
}

export function editableHistoryTarget(
  messages: Message[],
  input: Record<string, unknown>,
): Message | null {
  const latest = messages
    .filter((message) => message.role === "user")
    .slice(-1)[0];
  if (!latest || typeof latest.id !== "string") return null;
  if (input.id) return input.id === latest.id ? latest : null;
  const clientId = clientMessageId(input.metadata);
  if (clientId)
    return clientId === clientMessageId(latest.metadata) ? latest : null;
  return contentText(input.content) === contentText(latest.content)
    ? latest
    : null;
}

export type EditAttempt = {
  descriptor: { message_id: string; request_id: string };
  content: Array<Record<string, unknown>>;
  conversationId: string;
  agentId: string;
  isCurrent: () => boolean;
  accepted: () => void;
  rejected: (error: Error) => void;
};
