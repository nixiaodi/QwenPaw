export interface DeliveredArtifact {
  name: string;
  url: string;
}

export function artifactDisplayName(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** Only successful delivery tools establish which files this response published. */
export function deliveredArtifactsFromMessages(messages: unknown[]): DeliveredArtifact[] {
  const artifacts: DeliveredArtifact[] = [];
  for (const message of messages) {
    const content = record(message).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const data = record(record(block).data);
      if (data.name !== "send_file_to_user" || data.state !== "success" || typeof data.output !== "string") continue;
      try {
        const output: unknown = JSON.parse(data.output);
        if (!Array.isArray(output)) continue;
        const source = output.map(item => record(record(item).source)).find(item => typeof item.url === "string");
        const text = output.map(item => record(item).text).filter(item => typeof item === "string").join("\n");
        const url = text.match(/Download link:\s*(\/api\/console\/artifacts\/[0-9a-f-]{36}\/download)\b/i)?.[1];
        if (!source || !url) continue;
        const name = artifactDisplayName(new URL(String(source.url)).pathname.split("/").pop() || "");
        if (name) artifacts.push({name, url});
      } catch {
        // Malformed or incomplete streaming results cannot authorize a link.
      }
    }
  }
  return artifacts;
}
