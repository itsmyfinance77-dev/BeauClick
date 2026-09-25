'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Skeleton } from './ui';
import { Badge, PageHeader } from './kit';
import { useAuth } from '@/lib/auth-context';
import { ApiRequestError, type ApiClient } from '@/lib/api-client';
import { chatReports, mediaReports, reviewQueue, verificationQueue } from '@/lib/admin-api';
import {
  CHAT_REPORT_COUNT_LIMIT,
  heldModerationQueues,
  queueCountWording,
  type ModerationCapability,
  type ModerationQueue,
  type QueueCount,
} from '@/lib/admin-access';
import styles from './moderator-landing.module.css';

/**
 * The moderator landing — #264, `52_MODERATOR_LANDING.md` §3–§4.
 *
 * What `/admin` renders for a caller holding moderation capabilities and not
 * `bc_manage_platform`. One card per moderation capability HELD, in the fixed
 * order verification · media · reviews · chat. There is no card for a
 * capability not held — no disabled card and no "you cannot see…" list — and
 * nothing else: no platform figures, no audit excerpt, no search, no finance.
 *
 * A single held capability still gets this page with one card. There is
 * deliberately no redirect to that queue: `/admin` would then mean different
 * things as capabilities change live, and the back button would bounce.
 *
 * Each card reads its own count and fails, retries and is revoked on its own.
 */
export function ModeratorLanding() {
  const { user } = useAuth();
  const queues = heldModerationQueues(user?.capabilities);

  return (
    <div className={styles.page}>
      <PageHeader title="صف‌های بررسی" />
      <ul className={styles.cards} data-testid="moderation-queues">
        {queues.map((queue) => (
          <QueueCard key={queue.capability} queue={queue} />
        ))}
      </ul>
    </div>
  );
}

/**
 * Where each count comes from — §3's table. Three queues are paginated and
 * return an exact `meta.pagination.total` for `limit=1`. The chat route has no
 * total at all, so its figure is `items.length` for a known limit, and the
 * wording says so (`queueCountWording`).
 */
const COUNT_SOURCES: Record<ModerationCapability, (api: ApiClient) => Promise<QueueCount>> = {
  bc_moderate_verification: async (api) => exact((await verificationQueue(api, 1, 1)).meta?.pagination?.total),
  bc_moderate_media: async (api) => exact((await mediaReports(api, 1, 1)).meta?.pagination?.total),
  bc_moderate_reviews: async (api) => exact((await reviewQueue(api, 1, 1)).meta?.pagination?.total),
  bc_moderate_chat: async (api) => {
    const items = (await chatReports(api, { limit: CHAT_REPORT_COUNT_LIMIT })).data?.items;
    if (!Array.isArray(items)) throw new Error('missing items');
    return { kind: 'bounded', value: items.length, limit: CHAT_REPORT_COUNT_LIMIT };
  },
};

/** A total the server did not return is a failed read, never a guessed zero. */
function exact(total: number | undefined): QueueCount {
  if (typeof total !== 'number') throw new Error('missing total');
  return { kind: 'exact', value: total };
}

type CardState =
  | { status: 'loading' }
  | { status: 'ready'; count: QueueCount }
  | { status: 'error' }
  | { status: 'revoked' };

function QueueCard({ queue }: { queue: ModerationQueue }) {
  const { api, reloadUser } = useAuth();
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    COUNT_SOURCES[queue.capability](api).then(
      (count) => {
        if (!cancelled) setState({ status: 'ready', count });
      },
      (err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 403) {
          // §4: the server says this capability is gone. No retry, no stale
          // count, and `/v1/me` is re-read so the card leaves at the next read.
          setState({ status: 'revoked' });
          void reloadUser();
          return;
        }
        setState({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, reloadUser, queue.capability, attempt]);

  const wording = state.status === 'ready' ? queueCountWording(state.count) : null;
  const empty = state.status === 'ready' && state.count.value === 0;

  return (
    <li
      className={`${styles.card} ${empty ? styles.cardEmpty : ''}`}
      data-queue={queue.href}
      data-state={state.status}
      aria-busy={state.status === 'loading' ? true : undefined}
    >
      <h2 className={styles.cardTitle}>
        {state.status === 'revoked' ? (
          // The queue is no longer theirs: nothing to link to.
          queue.label
        ) : (
          <Link
            href={queue.href}
            className={styles.cardLink}
            // The count is in the name, so it is announced with the
            // destination rather than read as a bare figure after it.
            aria-label={wording ? `${queue.label}، ${wording}` : undefined}
          >
            {queue.label}
          </Link>
        )}
      </h2>

      {state.status === 'loading' ? (
        <div className={styles.cardBody}>
          <Skeleton width="60%" height={20} />
        </div>
      ) : null}

      {state.status === 'ready' ? (
        <div className={styles.cardBody} aria-hidden="true">
          {empty ? <Badge tone="success">{wording}</Badge> : <span className={styles.count}>{wording}</span>}
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div className={styles.cardBody} role="alert">
          <p className={styles.message}>تعداد این صف خوانده نشد.</p>
          <Button type="button" variant="ghost" inline onClick={retry}>
            تلاش دوباره
          </Button>
        </div>
      ) : null}

      {state.status === 'revoked' ? (
        <div className={styles.cardBody}>
          <p className={styles.message}>دسترسی شما به این صف تغییر کرده است.</p>
        </div>
      ) : null}
    </li>
  );
}
