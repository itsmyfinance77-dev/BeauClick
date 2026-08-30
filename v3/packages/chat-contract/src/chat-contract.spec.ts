import {
  CHAT_CLOSED_REASONS,
  CHAT_COUNTERPARTY_TYPES,
  CHAT_DEFAULT_PAGE_SIZE,
  CHAT_MAX_MESSAGES_PER_DAY,
  CHAT_MAX_MESSAGES_PER_MINUTE,
  CHAT_MAX_MESSAGE_CHARACTERS,
  CHAT_MAX_PAGE_SIZE,
  CHAT_MAX_REPORTS_PER_DAY,
  CHAT_MAX_REPORT_NOTE_CHARACTERS,
  CHAT_MODERATION_ACTIONS,
  CHAT_MODERATOR_POST_DECISION_DAYS,
  CHAT_MODERATOR_WINDOW_MESSAGES,
  CHAT_POLL_IDLE_MS,
  CHAT_POLL_LIST_MS,
  CHAT_POLL_THREAD_MS,
  CHAT_REFUSAL_REASONS,
  CHAT_REPORT_REASONS,
  CHAT_REPORT_STATUSES,
  CHAT_RETENTION_MONTHS,
  CHAT_SEND_WINDOW_DAYS,
  CHAT_SIDES,
  chatTextLength,
  isAcceptableChatMessage,
  isAcceptableReportNote,
  isChatCounterpartyType,
  isChatRefusalReason,
  isChatReportReason,
  isRetryableAfterEditing,
} from './chat-contract';

/**
 * The browser-safe contract, tested for the properties the SERVER and the PAGE
 * both depend on.
 *
 * Each case pins a place the two halves could silently disagree, which is the
 * whole reason this package exists rather than the page keeping its own string
 * literals.
 */
describe('chat contract', () => {
  describe('the owner-decided numbers', () => {
    /**
     * Written as literals, deliberately.
     *
     * Every number here is a decision recorded in `V3.2_DECISION_REGISTER.md` §B
     * on 2026-08-30, not an engineering default. A test that read the constant
     * and compared it to itself would pass after somebody quietly changed 90 days
     * to 900; writing the literal means changing the policy requires editing a
     * file whose comments say it is a decision-register entry.
     */
    it('pins V32-DEC-012 through V32-DEC-015 as literals a change has to confront', () => {
      expect(CHAT_SEND_WINDOW_DAYS).toBe(90);
      expect(CHAT_RETENTION_MONTHS).toBe(24);
      expect(CHAT_MAX_REPORTS_PER_DAY).toBe(5);
      expect(CHAT_MAX_REPORT_NOTE_CHARACTERS).toBe(500);
      expect(CHAT_MODERATOR_WINDOW_MESSAGES).toBe(50);
      expect(CHAT_MODERATOR_POST_DECISION_DAYS).toBe(30);
      expect(CHAT_MAX_MESSAGES_PER_MINUTE).toBe(20);
      expect(CHAT_MAX_MESSAGE_CHARACTERS).toBe(2000);
    });

    it('keeps the daily send cap well above the per-minute one', () => {
      // A daily cap below 60x the minute cap would make the minute limit
      // unreachable and the two would be one limit wearing two names.
      expect(CHAT_MAX_MESSAGES_PER_DAY).toBeGreaterThan(CHAT_MAX_MESSAGES_PER_MINUTE);
    });

    it('backs polling off to a longer interval when idle, never a shorter one', () => {
      expect(CHAT_POLL_THREAD_MS).toBeLessThan(CHAT_POLL_LIST_MS);
      expect(CHAT_POLL_IDLE_MS).toBeGreaterThan(CHAT_POLL_LIST_MS);
    });

    it('caps a page below anything that would be an unbounded list', () => {
      expect(CHAT_DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(CHAT_MAX_PAGE_SIZE);
      expect(CHAT_MAX_PAGE_SIZE).toBe(100);
    });
  });

  describe('closed vocabularies', () => {
    /**
     * `V32-DEC-010`: the customer never chooses between a professional and a
     * business — the counterparty is derived from the booking's order snapshot.
     * Two values, reusing commerce's existing seller-party vocabulary rather than
     * inventing a second one.
     */
    it('has exactly the two seller-party values commerce already uses', () => {
      expect([...CHAT_COUNTERPARTY_TYPES]).toEqual(['professional', 'business']);
      expect(isChatCounterpartyType('professional')).toBe(true);
      expect(isChatCounterpartyType('staff')).toBe(false);
      expect(isChatCounterpartyType(null)).toBe(false);
    });

    it('has exactly two sides, so there is no group-conversation shape to fill in', () => {
      expect([...CHAT_SIDES]).toEqual(['customer', 'seller']);
    });

    /**
     * The absence that matters most in this file.
     *
     * `V32-DEC-014` requires that the blocked party is never told who blocked
     * them. A `blocked_by_them` reason would tell them, so there is exactly one
     * `blocked` reason and both parties receive it.
     */
    it('has one blocked reason, not two, so a blocked party is never told who blocked them', () => {
      const blockedReasons = CHAT_REFUSAL_REASONS.filter((r) => r.includes('block'));
      expect(blockedReasons).toEqual(['blocked']);
      expect(CHAT_REFUSAL_REASONS as readonly string[]).not.toContain('blocked_by_them');
      expect(CHAT_REFUSAL_REASONS as readonly string[]).not.toContain('you_blocked_them');
    });

    it('has exactly nine refusal reasons', () => {
      // The count is asserted so adding one is a deliberate act with a failing
      // test attached -- the moment somebody must also add the Persian copy and
      // the page's branch for it.
      expect(CHAT_REFUSAL_REASONS).toHaveLength(9);
      expect(isChatRefusalReason('not_eligible')).toBe(true);
      expect(isChatRefusalReason('no_such_professional')).toBe(false);
    });

    it('has seven report reasons, including the chat-specific one', () => {
      expect([...CHAT_REPORT_REASONS]).toEqual([
        'harassment',
        'spam',
        'scam_or_fraud',
        'explicit',
        'personal_data',
        'off_platform_payment',
        'other',
      ]);
      // The one addition to `media.abuse_reports`' set. Folding it into `other`
      // would make the most financially actionable category invisible in a queue.
      expect(isChatReportReason('off_platform_payment')).toBe(true);
    });

    it('mirrors the media report lifecycle exactly', () => {
      expect([...CHAT_REPORT_STATUSES]).toEqual(['open', 'upheld', 'rejected']);
    });

    /**
     * `V32-DEC-014`: moderators cannot edit or delete participant messages.
     *
     * The way that is kept is by having no action able to express it. If somebody
     * adds `delete_message`, this fails before the schema, the API, or a
     * moderator ever sees it.
     */
    it('cannot express a moderation action that edits or deletes a message', () => {
      expect([...CHAT_MODERATION_ACTIONS]).toEqual(['warn_sender', 'close_conversation', 'restrict_sender']);
      for (const forbidden of ['delete_message', 'edit_message', 'remove_message', 'redact']) {
        expect(CHAT_MODERATION_ACTIONS as readonly string[]).not.toContain(forbidden);
      }
    });

    it('has two closure reasons and neither destroys history', () => {
      expect([...CHAT_CLOSED_REASONS]).toEqual(['moderation', 'blocked']);
    });
  });

  describe('no attachment surface exists', () => {
    /**
     * The milestone boundary, asserted as an absence over the whole module.
     *
     * Attachments are out of V3.2-B entirely — no table, no contract field, no
     * event field. An always-empty `attachments: []` would be a promise a client
     * codes against, and removing it later would be a breaking change to undo
     * something that never worked.
     */
    it('exports nothing whose name mentions attachments, files, or media', async () => {
      const module = await import('./chat-contract');
      const names = Object.keys(module).join(' ').toLowerCase();
      for (const word of ['attach', 'upload', 'file', 'media', 'image']) {
        expect(names).not.toContain(word);
      }
    });
  });

  describe('chatTextLength', () => {
    /**
     * The measurement both sides use, and the reason it is not `.length`.
     *
     * `.length` counts UTF-16 units, so a surrogate pair counts as two. A limit
     * expressed that way silently halves for a user who types an emoji and does
     * not for one who does not — and the page's counter and the server's refusal
     * then disagree about the same string.
     */
    it('counts code points, not UTF-16 units', () => {
      const withAstral = 'سلام👋';
      expect(withAstral.length).toBe(6);
      expect(chatTextLength(withAstral)).toBe(5);
    });

    it('normalises to NFC, so composed and decomposed Persian agree', () => {
      // Built from code points rather than written as literals: an editor or a
      // git filter normalising the file would silently turn the decomposed form
      // into the composed one and the test would pass vacuously.
      const composed = String.fromCodePoint(0x0622); // آ
      const decomposed = String.fromCodePoint(0x0627, 0x0653); // ا + maddah above

      expect(decomposed.length).toBe(2);
      expect(decomposed.normalize('NFC')).toBe(composed);
      expect(chatTextLength(decomposed)).toBe(1);
      expect(chatTextLength(composed)).toBe(chatTextLength(decomposed));
    });

    it('counts a Persian half-space as the one character it is', () => {
      expect(chatTextLength('می‌رود')).toBe(6);
    });
  });

  describe('isAcceptableChatMessage', () => {
    it('rejects empty and whitespace-only messages', () => {
      expect(isAcceptableChatMessage('')).toBe(false);
      expect(isAcceptableChatMessage('   \n\t ')).toBe(false);
    });

    it('accepts exactly the limit and rejects one past it', () => {
      expect(isAcceptableChatMessage('ا'.repeat(CHAT_MAX_MESSAGE_CHARACTERS))).toBe(true);
      expect(isAcceptableChatMessage('ا'.repeat(CHAT_MAX_MESSAGE_CHARACTERS + 1))).toBe(false);
    });

    it('measures the trimmed value, so trailing whitespace cannot push a message over', () => {
      expect(isAcceptableChatMessage(`${'ا'.repeat(CHAT_MAX_MESSAGE_CHARACTERS)}     `)).toBe(true);
    });

    it('accepts an emoji-heavy message that .length would have rejected', () => {
      // 1200 astral characters is 2400 UTF-16 units -- over by `.length` and
      // comfortably under by the product rule.
      expect(isAcceptableChatMessage('👋'.repeat(1200))).toBe(true);
    });
  });

  describe('isAcceptableReportNote', () => {
    it('treats an absent or blank note as acceptable, because it is optional', () => {
      expect(isAcceptableReportNote(null)).toBe(true);
      expect(isAcceptableReportNote(undefined)).toBe(true);
      expect(isAcceptableReportNote('   ')).toBe(true);
    });

    it('accepts exactly the limit and rejects one past it', () => {
      expect(isAcceptableReportNote('ا'.repeat(CHAT_MAX_REPORT_NOTE_CHARACTERS))).toBe(true);
      expect(isAcceptableReportNote('ا'.repeat(CHAT_MAX_REPORT_NOTE_CHARACTERS + 1))).toBe(false);
    });
  });

  describe('isRetryableAfterEditing', () => {
    /**
     * Only a too-long message is fixable by editing and resending. Everything
     * else is a limit, a wait, or a decision, and leaving the composer enabled
     * for those invites a user to retype the same message into the same refusal.
     */
    it('keeps the composer open only for a message the user can shorten', () => {
      expect(isRetryableAfterEditing('message_too_long')).toBe(true);
      for (const reason of CHAT_REFUSAL_REASONS.filter((r) => r !== 'message_too_long')) {
        expect(isRetryableAfterEditing(reason)).toBe(false);
      }
    });
  });
});
