'use client';

import type { ReactNode } from 'react';
import { Alert } from './ui';
import { PageHeader } from './kit';
import { ChatInbox, StartFromBookingsLink } from './chat-inbox';
import { useAuth } from '@/lib/auth-context';
import type { ChatInboxFilter } from '@/lib/chat-api';

/**
 * The frame the three chat routes share: one heading, the capability check, the
 * inbox narrowed as the route asks.
 *
 * `bc_use_chat` is held by customers, professionals and business accounts. A
 * session without it is sent no chat request at all; the server's
 * `CapabilityGuard` remains the control.
 */
export function ChatPage({
  title,
  subtitle,
  filter,
  emptyAction = <StartFromBookingsLink />,
}: {
  title: string;
  subtitle: string;
  filter: ChatInboxFilter;
  emptyAction?: ReactNode;
}) {
  const { user } = useAuth();
  const allowed = user?.capabilities?.includes('bc_use_chat') ?? false;
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      {allowed ? <ChatInbox filter={filter} emptyAction={emptyAction} /> : <Alert tone="info">گفتگو برای حساب شما فعال نیست.</Alert>}
    </div>
  );
}
