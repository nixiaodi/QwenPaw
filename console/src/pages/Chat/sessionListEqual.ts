import type { ExtendedSession } from "../../stores/sessionListStore";

const listFields = [
  "id",
  "name",
  "realId",
  "sessionId",
  "userId",
  "channel",
  "createdAt",
  "updatedAt",
  "status",
  "generating",
  "pinned",
  "archived",
  "archivedAt",
  "accessRole",
  "readOnly",
  "sharedBy",
] as const;

/** Only list metadata participates; message history is loaded independently. */
export function areSessionListsEqual(
  previous: readonly ExtendedSession[],
  next: readonly ExtendedSession[],
): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  return previous.every((item, index) =>
    listFields.every((field) => item[field] === next[index][field]),
  );
}
