const IDENTITY_EVENT = "qwenpaw:chat-session-identity";
let revision = 0;
let lastIdentity = "";

/** Publish backend identity changes without importing the auth/session graph. */
export function publishChatSessionIdentity(
  sessionId: string,
  conversationId: string,
) {
  const identity = JSON.stringify([sessionId, conversationId]);
  if (identity === lastIdentity) return;
  lastIdentity = identity;
  revision += 1;
  window.dispatchEvent(new Event(IDENTITY_EVENT));
}

export const getChatSessionRevision = () => revision;
export function subscribeChatSessionIdentity(listener: () => void) {
  window.addEventListener(IDENTITY_EVENT, listener);
  return () => window.removeEventListener(IDENTITY_EVENT, listener);
}
