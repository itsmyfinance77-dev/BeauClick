'use client';

import { useEffect, useRef, useState } from 'react';
import { CHAT_POLL_IDLE_AFTER_EMPTY, CHAT_POLL_IDLE_MS, CHAT_POLL_LIST_MS, type ChatUnreadCountView } from '@beauclick/chat-contract';
import type { ApiClient } from './api-client';
import { chatApi } from './chat-api';

/**
 * Polling, which is chat's transport (`V32-DEC-014` milestone boundary): no
 * websocket, no SSE, no typing or presence.
 *
 * The contract's own rule, as a pure function so it can be pinned: poll at the
 * surface's active interval, back off to `CHAT_POLL_IDLE_MS` once
 * `CHAT_POLL_IDLE_AFTER_EMPTY` polls in a row changed nothing, or at once while
 * the tab is hidden. Any change resets the streak.
 */
export function nextPollDelay(activeMs: number, emptyStreak: number, hidden: boolean): number {
  if (hidden || emptyStreak >= CHAT_POLL_IDLE_AFTER_EMPTY) return CHAT_POLL_IDLE_MS;
  return activeMs;
}

function isHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/**
 * Calls `poll` repeatedly while `enabled`. `poll` resolves `true` when it saw
 * something new. A tab coming back into view polls at once and resets the
 * back-off. A failed poll counts as "nothing new" and the loop continues — the
 * surface shows its own error; the loop never stops on one.
 */
export function usePoll(poll: () => Promise<boolean>, activeMs: number, enabled: boolean): void {
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let emptyStreak = 0;

    const schedule = () => {
      if (cancelled) return;
      timer = setTimeout(run, nextPollDelay(activeMs, emptyStreak, isHidden()));
    };
    const run = async () => {
      timer = null;
      let changed = false;
      try {
        changed = await pollRef.current();
      } catch {
        changed = false;
      }
      emptyStreak = changed ? 0 : emptyStreak + 1;
      schedule();
    };
    const onVisible = () => {
      if (isHidden() || cancelled) return;
      emptyStreak = 0;
      if (timer) clearTimeout(timer);
      void run();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [activeMs, enabled]);
}

/** Fired with the server's own unread figures after a mark-read, so the header updates at once. */
export const CHAT_UNREAD_EVENT = 'bc:chat-unread';

export function announceChatUnread(unread: ChatUnreadCountView): void {
  window.dispatchEvent(new CustomEvent<ChatUnreadCountView>(CHAT_UNREAD_EVENT, { detail: unread }));
}

/**
 * The header's unread figure: server-computed, never decremented locally.
 * `null` while unknown or after a failed read — the header then draws no badge
 * and no number, never a guessed one (spec 51 §2.1).
 */
export function useChatUnread(api: ApiClient, enabled: boolean): number | null {
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled) {
      setTotal(null);
      return;
    }
    const onEvent = (event: Event) => setTotal((event as CustomEvent<ChatUnreadCountView>).detail.total);
    window.addEventListener(CHAT_UNREAD_EVENT, onEvent);
    return () => window.removeEventListener(CHAT_UNREAD_EVENT, onEvent);
  }, [enabled]);

  const last = useRef<number | null>(null);
  usePoll(
    async () => {
      try {
        const res = await chatApi.unreadCount(api);
        const next = res.data?.total ?? null;
        const changed = next !== last.current;
        last.current = next;
        setTotal(next);
        return changed;
      } catch {
        last.current = null;
        setTotal(null);
        return false;
      }
    },
    CHAT_POLL_LIST_MS,
    enabled,
  );

  // The first read happens at mount, not one interval later.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    chatApi
      .unreadCount(api)
      .then((res) => {
        if (cancelled) return;
        last.current = res.data?.total ?? null;
        setTotal(last.current);
      })
      .catch(() => {
        if (!cancelled) setTotal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [api, enabled]);

  return total;
}
