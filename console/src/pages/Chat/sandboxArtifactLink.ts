import type { AgentArtifact } from "../../api/modules/artifacts";
import type { DeliveredArtifact } from "./deliveredArtifacts";

const PREFIX = "#qwenpaw-artifact-download=";

function safeFilename(path: string): string | null {
  try {
    const decoded = decodeURIComponent(path);
    if (/[\\\x00-\x1f]/.test(decoded)) return null;
    const segments = decoded.split("/");
    if (
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    )
      return null;
    return segments[segments.length - 1] ?? null;
  } catch {
    return null;
  }
}

/** Only turn model sandbox links into references, never into server file paths. */
export function normalizeSandboxArtifactLinks(markdown: string, delivered: DeliveredArtifact[] = []): string {
  return markdown
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi,
            (original, label: string, href: string) => {
              if (!/(下载|download)/i.test(label) || !/\.[a-z0-9]{2,5}(?:\?|$)/i.test(href)) return original;
              const matches = delivered.filter(item => {
                const stem = item.name.replace(/\.[^.]+$/, "").replace(/[_-]\d{4}-\d{2}-\d{2}$/, "");
                return stem.length >= 3 && label.includes(stem);
              });
              return matches.length === 1 ? `[${label}](${matches[0].url})` : original;
            },
          ).replace(
            /(\]\(\s*)sandbox:\/mnt\/data\/([^\s)]+)(\s*\))/gi,
            (original, start: string, path: string, end: string) => {
              const name = safeFilename(path);
              return name
                ? `${start}${PREFIX}${encodeURIComponent(name)}${end}`
                : original;
            },
          ),
    )
    .join("");
}

export function sandboxArtifactName(href: string): string | null {
  return href.startsWith(PREFIX)
    ? safeFilename(href.slice(PREFIX.length))
    : null;
}

export function latestConversationArtifact(
  artifacts: AgentArtifact[],
  name: string,
  conversationId?: string,
): AgentArtifact | null {
  if (!conversationId) return null;
  // A filename without a version refers to the most recently registered output
  // in this conversation, never an equally named file in another conversation.
  return (
    artifacts
      .filter(
        (item) =>
          item.status === "active" &&
          item.conversation_id === conversationId &&
          item.original_name === name,
      )
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  );
}
