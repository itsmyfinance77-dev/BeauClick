'use client';

import { ProtectedRoute } from '@/components/protected-route';
import { ChatPage } from '@/components/chat-page';

/**
 * `/messages` — the caller's whole inbox, both sides (`36_INTERNAL_CHAT.md`;
 * the header's messages entry, spec 51 §2.1). A professional who has also
 * booked as a customer sees both kinds of conversation here, each labelled
 * from the server's `side`.
 */
export default function MessagesPage() {
  return (
    <ProtectedRoute>
      <ChatPage
        title="پیام‌ها"
        subtitle="گفتگو با متخصص یا کسب‌وکاری که از او رزرو داشته‌اید. گفتگو فقط از یک رزروِ تأییدشده شروع می‌شود."
        filter={{}}
      />
    </ProtectedRoute>
  );
}
