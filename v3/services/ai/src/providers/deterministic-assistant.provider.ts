import { Injectable } from '@nestjs/common';

import { AI_MAX_RECOMMENDATIONS_PER_REPLY, aiInputLength, AI_MAX_REPLY_CHARACTERS } from '@beauclick/ai-contract';
import { formatCount, formatRating, formatToman } from '@beauclick/persian-utils';

import {
  AiAssistantProvider,
  AiCompletionDraft,
  AiCompletionRequest,
  DETERMINISTIC_PROVIDER_KEY,
} from './ai-provider.interface';
import { AiPublicProfessionalSummary } from '../context/ai-context.ports';

/**
 * The deterministic local assistant — a REGISTERED PROVIDER, not a fallback.
 *
 * `F-03` records the V2 mistake this design exists to avoid: a local stand-in
 * that was substituted implicitly whenever the vendor failed, so a degraded
 * answer and a real one were indistinguishable to the person reading them. This
 * one has its own key, is selected explicitly, and is never reached for when
 * something else breaks (see `AiProviderRegistry`).
 *
 * ## What it actually does, stated plainly
 *
 * It NARRATES. Given a customer's structured intent and a list of candidates the
 * existing search read model already produced, it composes Persian sentences
 * describing what is there. Every number in its output — a price, a rating, a
 * review count — came from the catalogue. It generates no claims, and there is
 * nothing in it that could.
 *
 * It is therefore genuinely useful and genuinely limited, and the reply says so
 * in its own words rather than leaving the interface to add a disclaimer
 * somebody might restyle away. `AI_ASSISTANT_DISCLOSURE` below is that sentence.
 *
 * ## What it must never do, and cannot
 *
 * **It must never claim to be a language model.** It says the opposite, every
 * time, in the reply body.
 *
 * **It cannot converse.** There is no state machine, no intent classifier, and
 * no attempt at one. Asked something it has no structured answer for, it says
 * so and offers what it does have. A deterministic assistant that guessed at
 * conversational intent would be a worse thing than one that is clearly a
 * catalogue narrator: the first invites trust it has not earned.
 *
 * **It cannot act.** It returns text and candidate ids. `V32-DEC-004` prohibits
 * AI-initiated mutation, and this provider has no injected collaborator through
 * which it could attempt one — no repository, no `EntityManager`, no service.
 * Its entire input is the `AiCompletionRequest` it is handed.
 *
 * ## Why it still obeys every control
 *
 * Consent, quota, input screening, output validation, and re-verification all
 * run outside this class and run identically for it. Zero external cost is not
 * a reason to exempt a path: the retention and export obligations are the same
 * whichever provider answered, and a quota that only exists on the expensive
 * path is a quota nobody has tested (`V32-DEC-008`, ADR-030 T5).
 */

/**
 * The sentence that appears in every deterministic reply.
 *
 * NOT the legal disclosure. `V32-DEC-006` leaves the final customer-facing
 * disclosure copy to legal review and explicitly does not authorize it in this
 * backend phase. This is a narrower, factual statement about what produced the
 * paragraph the customer is reading — the honesty requirement of ADR-029 §3,
 * which is an engineering obligation rather than a legal one.
 */
export const AI_ASSISTANT_DISCLOSURE =
  'این پاسخ توسط دستیار محلی و ساده‌ی بیوکلیک تهیه شده است، نه یک مدل زبانی، و فقط اطلاعات عمومی ثبت‌شده در سامانه را بازگو می‌کند.';

/** Shown when the catalogue returned nothing for the customer's structured intent. */
const NO_CANDIDATES =
  'در حال حاضر با توجه به شهر، تخصص و بودجه‌ی ثبت‌شده‌ی شما، متخصص عمومی‌ای برای پیشنهاد پیدا نکردم. می‌توانید در «مسیر زیبایی» شهر، تخصص یا سقف بودجه را تغییر دهید و دوباره بپرسید.';

@Injectable()
export class DeterministicAssistantProvider implements AiAssistantProvider {
  readonly key = DETERMINISTIC_PROVIDER_KEY;
  readonly displayName = 'دستیار محلی قطعی';
  readonly mode = 'deterministic' as const;

  /**
   * False, and this is the field the readiness surface reads.
   *
   * The same shape as `SmsProvider.deliversExternally` and
   * `ErrorReporterPort.reportsExternally`: the component's own statement about
   * whether bytes leave the building, rather than something inferred from
   * configuration. Nothing here opens a socket.
   */
  readonly respondsExternally = false;

  /**
   * Composes a reply.
   *
   * Deterministic in the strict sense: the same request produces the same
   * output, byte for byte. No clock is read, no random number is drawn, and the
   * candidate order is the one the catalogue port supplied. That property is
   * what makes the whole safety pipeline testable — an output-validation test
   * that had to accommodate a varying reply would be testing the accommodation.
   *
   * `async` because the port is async and a real adapter will genuinely await.
   * Nothing here does.
   */
  async complete(request: AiCompletionRequest): Promise<AiCompletionDraft> {
    const { context } = request;
    const candidates = context.candidates.slice(0, AI_MAX_RECOMMENDATIONS_PER_REPLY);

    if (candidates.length === 0) {
      return {
        reply: `${NO_CANDIDATES}\n\n${AI_ASSISTANT_DISCLOSURE}`,
        recommendations: [],
      };
    }

    const lines = candidates.map((candidate, index) => `${index + 1}. ${this.describe(candidate, context.services)}`);

    const opening = this.opening(context.journey.cityId !== undefined, context.journey.budgetToman);
    const reply = this.trimToLimit([opening, ...lines, '', AI_ASSISTANT_DISCLOSURE].join('\n'));

    return {
      reply,
      // Ids only. No display name travels back from a provider — the caller uses
      // the catalogue's own, so a model that invents a real id and a false name
      // gets neither (ADR-030 T3). The deterministic provider could not invent
      // one, and the contract is shaped for the adapter that could.
      recommendations: candidates.map((candidate) => ({
        targetType: 'professional' as const,
        targetId: candidate.professionalId,
      })),
    };
  }

  /**
   * One candidate, as a sentence.
   *
   * Only fields present on `AiPublicProfessionalSummary` are readable here, and
   * that type carries no biography, no contact detail, and no free text — the
   * context boundary is upstream of this method, so there is nothing to be
   * careful about while writing it. That is the intended experience of working
   * inside this class.
   */
  private describe(candidate: AiPublicProfessionalSummary, services: readonly { professionalId: string; name: string; priceToman: number }[]): string {
    const parts: string[] = [candidate.displayName];

    if (candidate.cityName) parts.push(`در ${candidate.cityName}`);
    if (candidate.specialtyNames.length > 0) parts.push(`— ${candidate.specialtyNames.slice(0, 3).join('، ')}`);
    if (candidate.isVerified) parts.push('(احراز هویت شده)');

    const sentence = parts.join(' ');
    const details: string[] = [];

    if (candidate.reviewCount > 0) {
      // Both numbers, together. A rating without its sample size is the
      // classic misleading statistic: 5.0 from one review reads identically to
      // 5.0 from two hundred.
      details.push(`امتیاز ${formatRating(candidate.ratingAvg)} از ${formatCount(candidate.reviewCount)} نظر`);
    }

    const cheapest = services
      .filter((service) => service.professionalId === candidate.professionalId)
      .sort((a, b) => a.priceToman - b.priceToman)[0];
    if (cheapest) {
      details.push(`${cheapest.name} از ${formatToman(cheapest.priceToman)} تومان`);
    } else if (candidate.minPriceToman !== null) {
      details.push(`قیمت از ${formatToman(candidate.minPriceToman)} تومان`);
    }

    return details.length > 0 ? `${sentence} — ${details.join('، ')}` : sentence;
  }

  private opening(hasCity: boolean, budgetToman?: number): string {
    if (budgetToman !== undefined) {
      return `بر اساس ترجیحات ثبت‌شده‌ی شما${hasCity ? ' و شهر انتخابی' : ''} و سقف بودجه‌ی ${formatToman(budgetToman)} تومان، این گزینه‌ها را پیدا کردم:`;
    }
    return `بر اساس ترجیحات ثبت‌شده‌ی شما${hasCity ? ' و شهر انتخابی' : ''}، این گزینه‌ها را پیدا کردم:`;
  }

  /**
   * A hard stop before the schema's cap, not instead of it.
   *
   * `AiCompletionSchema` still validates this provider's output like anybody
   * else's — a provider is not trusted because it lives in this repository, and
   * a bug here must fail validation rather than be waved through. This exists so
   * that a customer with four verbose candidates gets a truncated last line
   * instead of a validation failure, and the belt-and-braces is deliberate.
   */
  private trimToLimit(reply: string): string {
    if (aiInputLength(reply) <= AI_MAX_REPLY_CHARACTERS) return reply;
    return [...reply.normalize('NFC')].slice(0, AI_MAX_REPLY_CHARACTERS - 1).join('') + '…';
  }
}
