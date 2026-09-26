'use client';

import { ProtectedRoute } from '@/components/protected-route';
import { ChatPage } from '@/components/chat-page';

/**
 * `/business/messages` — conversations addressed to a business the caller may
 * read for (`Prototype - Pro and Admin` §17): the owner and active managers
 * see the salon's whole inbox, a `practitioner_chat` holder only the
 * conversations with customers they personally served (`V33-DEC-033` R2).
 * Which rows appear is the server's per-request decision; this page only asks
 * for the business half.
 */
export default function BusinessMessagesPage() {
  return (
    <ProtectedRoute>
      <ChatPage
        title="صندوق گفتگوی کسب‌وکار"
        subtitle="گفتگوی مشتری‌هایی که از کسب‌وکار شما رزرو داشته‌اند."
        filter={{ side: 'seller', counterpartyType: 'business' }}
        emptyAction={null}
      />
    </ProtectedRoute>
  );
}
