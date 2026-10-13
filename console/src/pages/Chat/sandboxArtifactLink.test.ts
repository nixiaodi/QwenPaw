import { describe, expect, it } from "vitest";
import {
  normalizeSandboxArtifactLinks,
  sandboxArtifactName,
  latestConversationArtifact,
} from "./sandboxArtifactLink";
import type { AgentArtifact } from "../../api/modules/artifacts";

describe("sandbox artifact links", () => {
  it("makes the generated report link usable without trusting a server file path", () => {
    const result = normalizeSandboxArtifactLinks(
      "**[下载报告](sandbox:/mnt/data/防水报告.pdf)**",
    );
    expect(result).toBe(
      "**[下载报告](#qwenpaw-artifact-download=" +
        encodeURIComponent("防水报告.pdf") +
        ")**",
    );
    expect(
      sandboxArtifactName(result.slice(result.indexOf("(#") + 1, -3)),
    ).toBe("防水报告.pdf");
  });
  it("does not rewrite code examples, external links or traversal", () => {
    for (const input of [
      "`[下载](sandbox:/mnt/data/demo.pdf)`",
      "[下载](https://elsewhere/report.pdf)",
      "[下载](sandbox:/mnt/data/../secret.txt)",
    ]) {
      expect(normalizeSandboxArtifactLinks(input)).toBe(input);
    }
    expect(
      sandboxArtifactName(
        "https://evil.example/#qwenpaw-artifact-download=report.pdf",
      ),
    ).toBeNull();
  });
  it("selects only the latest active matching artifact within this conversation", () => {
    const artifact = (
      id: string,
      conversation_id: string,
      created_at: string,
      status = "active",
    ) =>
      ({
        id,
        conversation_id,
        created_at,
        original_name: "report.pdf",
        status,
      }) as AgentArtifact;
    const records = [
      artifact("old", "chat-a", "2026-09-16"),
      artifact("new", "chat-a", "2026-09-17"),
      artifact("foreign", "chat-b", "2026-09-18"),
      artifact("deleted", "chat-a", "2026-09-19", "deleted"),
    ];
    expect(
      latestConversationArtifact(records, "report.pdf", "chat-a")?.id,
    ).toBe("new");
    expect(
      latestConversationArtifact(records, "missing.pdf", "chat-a"),
    ).toBeNull();
    expect(
      latestConversationArtifact(records, "report.pdf", undefined),
    ).toBeNull();
  });
});
