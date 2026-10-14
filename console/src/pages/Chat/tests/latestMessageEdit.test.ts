import { describe, expect, it } from "vitest";
import {
  editedRequestContent,
  editedRequestFileList,
  editableHistoryTarget,
  requestText,
  editFailureKey,
} from "../latestMessageEdit";

describe("latest user message editing", () => {
  it("preserves attachments while replacing text", () => {
    const image = {
      type: "image",
      image_url: "/api/console/attachments/image",
    };
    const original = [{ type: "text", text: "old" }, image];
    expect(editedRequestContent(original, "new")).toEqual([
      { type: "text", text: "new" },
      image,
    ]);
    expect(original[0]).toEqual({ type: "text", text: "old" });
  });
  it("reuses uploaded files and images when creating the edited user card", () => {
    const imageUrl = "/api/console/attachments/image";
    const fileUrl = "/api/console/attachments/document";
    const files = editedRequestFileList([
      { type: "text", text: "edited" },
      {
        type: "file",
        file_url: fileUrl,
        file_name: "report.pdf",
        file_size: 128,
        file_id: "document",
      },
      { type: "image", image_url: imageUrl },
    ]);
    expect(files).toEqual([
      {
        uid: fileUrl,
        name: "report.pdf",
        type: "application/octet-stream",
        size: 128,
        file_id: "document",
        url: fileUrl,
        status: "done",
        response: { url: fileUrl },
        thumbUrl: undefined,
      },
      {
        uid: imageUrl,
        name: "image",
        type: "image/png",
        size: undefined,
        file_id: undefined,
        url: imageUrl,
        status: "done",
        response: { url: imageUrl },
        thumbUrl: imageUrl,
      },
    ]);
    expect(files.every((file) => !file.originFileObj)).toBe(true);
  });
  it("selects the latest user even when an assistant follows it", () => {
    const input = {
      id: "latest",
      role: "user",
      content: [{ type: "text", text: "question" }],
    };
    expect(
      editableHistoryTarget(
        [
          { id: "earlier", role: "user", content: [] },
          input,
          { role: "assistant", content: [] },
        ],
        input,
      )?.id,
    ).toBe("latest");
  });
  it("rejects a stale tab even when another user message has identical text", () => {
    expect(
      editableHistoryTarget(
        [
          {
            id: "newer",
            role: "user",
            content: [{ type: "text", text: "same" }],
          },
        ],
        { id: "old", content: [{ type: "text", text: "same" }] },
      ),
    ).toBeNull();
  });
  it("matches an optimistic message using its client ID", () => {
    const metadata = { metadata: { qwenpaw_client_message_id: "client" } };
    expect(
      editableHistoryTarget(
        [{ id: "persisted", role: "user", content: [], metadata }],
        { metadata: { qwenpaw_client_message_id: "client" }, content: [] },
      )?.id,
    ).toBe("persisted");
  });
  it("reads only text parts from a multimodal user input", () => {
    expect(
      requestText({
        input: [
          { content: [{ type: "image" }, { type: "text", text: "hello" }] },
        ],
      }),
    ).toBe("hello");
  });
  it("distinguishes unrecoverable context from a newer user message", () => {
    expect(editFailureKey(409, "edit_run_unavailable")).toBe(
      "chat.editRunUnavailable",
    );
    expect(editFailureKey(409, "turn_context_unavailable")).toBe(
      "chat.editContextUnavailable",
    );
    expect(editFailureKey(409, "latest_message_changed")).toBe(
      "chat.editConflict",
    );
    expect(editFailureKey(409, "edit_request_conflict")).toBe(
      "chat.editConflict",
    );
    expect(editFailureKey(400, "invalid_edit_text")).toBe("chat.editFailed");
  });
});
