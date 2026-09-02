import {
  AI_CLOSURE_REASONS,
  AI_CONSENT_CONTRACT_KEY,
  AI_CONVERSATION_STATUSES,
  AI_DAILY_MESSAGE_QUOTA,
  AI_INACTIVITY_CLOSE_HOURS,
  AI_MAX_INPUT_CHARACTERS,
  AI_MAX_RECOMMENDATIONS_PER_REPLY,
  AI_MAX_REPLY_CHARACTERS,
  AI_MAX_RETAINED_CONVERSATIONS,
  AI_MESSAGE_ROLES,
  AI_PROVIDER_STATES,
  AI_RECOMMENDATION_TARGETS,
  AI_REFUSAL_REASONS,
  AI_RETENTION_DAYS,
  aiInputLength,
  isAcceptableAiInput,
  isAiProviderState,
  isAiRefusalReason,
  isSimulatedAssistantReply,
  isUserResolvableRefusal,
} from './ai-assistant-contract';

/**
 * The browser-safe contract, tested for the properties the SERVER and the PAGE
 * both depend on.
 *
 * These are not tests of trivia. Each one pins a place where the two halves
 * could silently disagree, which is the entire reason this package exists
 * instead of the page keeping its own string literals.
 */
describe('AI assistant contract', () => {
  describe('the owner-decided numbers', () => {
    /**
     * Asserted as literals, deliberately.
     *
     * Every number here is a product-owner decision recorded in
     * `V3.2_DECISION_REGISTER.md` on 2026-08-29, not an engineering default. A
     * test that read the constant and compared it to itself would pass after
     * somebody quietly changed twenty to two hundred; writing the literal out
     * means changing the policy requires editing a file that says, in a
     * comment, that it is a decision register entry.
     */
    it('pins V32-DEC-002 and V32-DEC-008 as literals a change has to confront', () => {
      expect(AI_DAILY_MESSAGE_QUOTA).toBe(20);
      expect(AI_MAX_RETAINED_CONVERSATIONS).toBe(20);
      expect(AI_INACTIVITY_CLOSE_HOURS).toBe(24);
      expect(AI_RETENTION_DAYS).toBe(30);
      expect(AI_MAX_INPUT_CHARACTERS).toBe(1000);
      expect(AI_MAX_RECOMMENDATIONS_PER_REPLY).toBe(4);
    });
  });

  describe('closed vocabularies', () => {
    it('has exactly three provider states and no vendor name among them', () => {
      expect([...AI_PROVIDER_STATES]).toEqual(['simulated', 'external', 'unavailable']);
    });

    it('has exactly seven refusal reasons', () => {
      // The count is asserted so that adding one is a deliberate act with a
      // failing test attached -- which is the moment somebody has to also add
      // the Persian copy and the page's branch for it.
      expect(AI_REFUSAL_REASONS).toHaveLength(7);
      expect([...AI_REFUSAL_REASONS]).toContain('quota_exhausted');
      expect([...AI_REFUSAL_REASONS]).toContain('unsafe_request');
    });

    /**
     * The prohibition in `V32-DEC-004`, expressed as a type-level absence.
     *
     * A preselected booking slot is prohibited, and the way that prohibition is
     * kept is by having no target type able to express one. If somebody adds
     * `'slot'` here, this test fails before the schema, the API, or the page
     * ever sees it.
     */
    it('cannot express a booking, slot, or order recommendation target', () => {
      expect([...AI_RECOMMENDATION_TARGETS]).toEqual(['professional', 'service']);
    });

    it('has no conversation status that reopens a closed session', () => {
      // `V32-DEC-002`: a closed session is never reopened. There is no
      // `reopened` state to transition to.
      expect([...AI_CONVERSATION_STATUSES]).toEqual(['active', 'closed']);
      expect([...AI_CLOSURE_REASONS]).toEqual(['inactivity', 'superseded']);
    });

    it('has exactly two message roles', () => {
      expect([...AI_MESSAGE_ROLES]).toEqual(['customer', 'assistant']);
    });

    it('rejects values outside each closed set', () => {
      expect(isAiProviderState('simulated')).toBe(true);
      expect(isAiProviderState('gpt-4')).toBe(false);
      expect(isAiProviderState(null)).toBe(false);
      expect(isAiRefusalReason('quota_exhausted')).toBe(true);
      expect(isAiRefusalReason('injection')).toBe(false); // server-side only, never published
    });
  });

  describe('isSimulatedAssistantReply', () => {
    /**
     * The honesty predicate the interface renders a badge from.
     *
     * `unavailable` counts as not-a-real-answer, and that is the case worth
     * pinning: a refusal is platform-authored text, and letting it render
     * without the same caveat an assistant reply gets would be the one place
     * the disclosure quietly disappears.
     */
    it('treats a refusal as not-a-real-model-answer, alongside the simulated one', () => {
      expect(isSimulatedAssistantReply('simulated')).toBe(true);
      expect(isSimulatedAssistantReply('unavailable')).toBe(true);
      expect(isSimulatedAssistantReply('external')).toBe(false);
    });
  });

  describe('isUserResolvableRefusal', () => {
    it('keeps the composer open only for the three the user can fix now', () => {
      expect(isUserResolvableRefusal('message_too_long')).toBe(true);
      expect(isUserResolvableRefusal('consent_required')).toBe(true);
      expect(isUserResolvableRefusal('conversation_closed')).toBe(true);

      // Retyping the same message into the same refusal helps nobody.
      expect(isUserResolvableRefusal('quota_exhausted')).toBe(false);
      expect(isUserResolvableRefusal('assistant_unavailable')).toBe(false);
      expect(isUserResolvableRefusal('unsafe_request')).toBe(false);
      expect(isUserResolvableRefusal('conversation_limit_reached')).toBe(false);
    });
  });

  describe('aiInputLength', () => {
    /**
     * The measurement both sides use, and the reason it is not `.length`.
     *
     * `.length` counts UTF-16 units, so a surrogate pair counts as two. A limit
     * expressed that way silently halves for a user who types an emoji and does
     * not for one who does not -- and the page's counter and the server's
     * refusal would then disagree about the same string, which is the exact
     * class of bug this package exists to prevent.
     */
    it('counts code points, not UTF-16 units', () => {
      const withAstral = 'سلام👋';
      expect(withAstral.length).toBe(6); // 5 + a surrogate pair
      expect(aiInputLength(withAstral)).toBe(5);
    });

    /**
     * Persian text arrives from browsers in more than one normalisation form.
     * Counting the raw string would make the limit depend on which keyboard
     * somebody typed with.
     */
    it('normalises to NFC before counting, so composed and decomposed agree', () => {
      const composed = 'آ'; // آ
      const decomposed = 'آ'; // ا + maddah above
      expect(decomposed.length).toBe(2);
      expect(aiInputLength(composed)).toBe(aiInputLength(decomposed));
    });

    it('counts a Persian half-space as the one character it is', () => {
      // ZWNJ is a real character in Persian orthography, not padding, and it
      // must count -- unlike in the SCREENING path, where it is stripped.
      expect(aiInputLength('می‌رود')).toBe(6);
    });
  });

  describe('isAcceptableAiInput', () => {
    it('rejects empty and whitespace-only input', () => {
      expect(isAcceptableAiInput('')).toBe(false);
      expect(isAcceptableAiInput('   \n\t ')).toBe(false);
    });

    it('accepts exactly the limit and rejects one past it', () => {
      expect(isAcceptableAiInput('ا'.repeat(AI_MAX_INPUT_CHARACTERS))).toBe(true);
      expect(isAcceptableAiInput('ا'.repeat(AI_MAX_INPUT_CHARACTERS + 1))).toBe(false);
    });

    it('measures the trimmed value, so trailing whitespace cannot push a message over', () => {
      expect(isAcceptableAiInput(`${'ا'.repeat(AI_MAX_INPUT_CHARACTERS)}     `)).toBe(true);
    });
  });

  describe('the consent contract key', () => {
    /**
     * `V32-DEC-006` leaves the final customer-facing disclosure copy to legal
     * review and explicitly does not authorize it in this backend phase.
     *
     * The key must therefore say `sandbox`, so an acceptance gathered under the
     * disclosure that exists today stays distinguishable from one gathered under
     * the approved wording that does not. Without that distinction, the day
     * legal signs off there is no way to tell who has ever seen anything.
     */
    it('names the sandbox acceptance, not a generic one', () => {
      expect(AI_CONSENT_CONTRACT_KEY).toBe('ai_assistant_sandbox_v1');
      expect(AI_CONSENT_CONTRACT_KEY).toContain('sandbox');
    });
  });

  describe('reply and recommendation caps', () => {
    it('bounds an assistant reply well below anything resembling a document', () => {
      expect(AI_MAX_REPLY_CHARACTERS).toBe(2000);
      expect(AI_MAX_REPLY_CHARACTERS).toBeGreaterThan(AI_MAX_INPUT_CHARACTERS);
    });
  });
});
