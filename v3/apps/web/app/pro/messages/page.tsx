'use client';

import { ChatPage } from '@/components/chat-page';

/**
 * `/pro/messages` — conversations addressed to the caller's professional
 * profile (`Prototype - Pro and Admin` §17). The server narrows the inbox to
 * the seller half and to professional counterparties; the `/pro` layout
 * already guards the route.
 */
export default function ProMessagesPage() {
  return (
    <ChatPage
      title="پیام‌ها"
      subtitle="گفتگوی مشتری‌هایی که از شما رزرو داشته‌اند."
      filter={{ side: 'seller', counterpartyType: 'professional' }}
      emptyAction={null}
    />
  );
}
