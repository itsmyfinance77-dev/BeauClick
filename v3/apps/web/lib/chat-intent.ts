/**
 * "Open this conversation when the inbox mounts" — #328.
 *
 * Starting a conversation from a booking lands the customer in `/messages` with
 * that thread open. The id does NOT travel in the URL: the notification
 * template links to the inbox rather than a thread for exactly this reason
 * (`chat_message_received`: an id in a URL leaks which conversation it was into
 * browser history and any referrer), and no chat content or id goes into
 * browser storage. A module variable survives a client-side navigation and
 * nothing else — a reload simply shows the inbox.
 */
let pending: string | null = null;

export function setPendingConversation(conversationId: string): void {
  pending = conversationId;
}

/** Returns the pending id once, then forgets it. */
export function takePendingConversation(): string | null {
  const value = pending;
  pending = null;
  return value;
}
