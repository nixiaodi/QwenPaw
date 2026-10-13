import { describe, expect, it } from "vitest";
import { findChatAgent } from "./chatAgentResolver";

describe("findChatAgent", () => {
  it("returns a matching agent without waiting for unrelated slow agents", async () => {
    const result = findChatAgent("found", ["slow", "fast"], (agentId) =>
      agentId === "slow"
        ? new Promise(() => {})
        : Promise.resolve([{ id: "found" }]),
    );
    expect(await result).toBe("fast");
  });
  it("returns the agent that owns a deep-linked chat", async () => {
    const result = await findChatAgent(
      "chat-ppt",
      ["contract-review", "ppt-creator"],
      async (agentId) =>
        agentId === "ppt-creator" ? [{ id: "chat-ppt" }] : [],
    );

    expect(result).toBe("ppt-creator");
  });

  it("ignores an unavailable agent and continues searching", async () => {
    const result = await findChatAgent(
      "chat-ppt",
      ["broken", "ppt-creator"],
      async (agentId) => {
        if (agentId === "broken") throw new Error("agent unavailable");
        return [{ id: "chat-ppt" }];
      },
    );

    expect(result).toBe("ppt-creator");
  });
});
