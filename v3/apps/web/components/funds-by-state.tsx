'use client';

import { formatToman } from '@beauclick/persian-utils';
import { Card } from '@/components/ui';
import type { WorkspaceFunds } from '@/lib/pro-api';

/**
 * The per-state funds section of screen 46 -- V3.3 `#43a` / #185, ADR-052 §14
 * and §16, design `46_FINANCE_WORKSPACE_AMENDMENT.md` including its reviewer
 * corrections.
 *
 * A section added to the finance workspace, not a screen: the three legacy
 * figures stay exactly where they are, and these twelve sit beside them
 * without ever being combined with them.
 *
 * ## Three groups, because there are three kinds of fact
 *
 * The design as delivered had two. `FinanceWorkspaceService.fundsFor`'s own
 * contract has three, and the difference is the whole point of the section:
 * `collected`, `platformAdvance` and `recoveredIn` are custody and
 * cash-position facts (ADR-052 §12's M1), **not** a payable figure. Rendered
 * inside the seller's own group, `collected` -- routinely the largest number
 * on the screen -- reads as "money owed to me", which is precisely the
 * misreading the no-total rule below exists to prevent.
 *
 * ## Nothing is summed, including within a group
 *
 * No total crosses the seller/platform boundary, and none is computed inside
 * the seller group either: the six are STATES, not shares of one whole, so
 * their sum is not a quantity that exists. There is no «موجودی», no summary
 * card, and no ratio between the new figures and the legacy trio.
 *
 * ## Why all twelve render, including the nine that are always zero today
 *
 * `#43a` posts only `collection` and `refund` journals, so until `#43b`-`#43g`
 * land (all `gate:external`) only `pending`, `collected` and `refunded` can be
 * non-zero. Hiding the rest would bake "today" into the UI and go on hiding
 * them once they became meaningful. The server returns twelve; showing a
 * subset would be a claim the server did not make. All-zero is handled where
 * it belongs instead -- as a correct answer with a sentence, never an empty
 * state and never an error.
 */

/** A group's fields, in the server's own order. The three lists together are exactly the twelve. */
const SELLER_STATES = ['pending', 'disputed', 'available', 'reserve', 'settled', 'refunded'] as const;
const CUSTODY_FACTS = ['collected', 'platformAdvance', 'recoveredIn'] as const;
const PLATFORM_FACTS = ['platformEarned', 'providerFee', 'recoveryOut'] as const;

type FundField = (typeof SELLER_STATES)[number] | (typeof CUSTODY_FACTS)[number] | (typeof PLATFORM_FACTS)[number];

/**
 * The ratified Persian labels from the amendment. Provisional per the pack's
 * own open item 2: these words will also appear in seller-facing copy, so a
 * change here is a copy decision, not a styling one.
 */
const LABEL: Record<FundField, string> = {
  pending: 'در انتظار',
  disputed: 'درگیرِ اختلاف',
  available: 'قابلِ تسویه',
  reserve: 'ذخیره',
  settled: 'تسویه‌شده',
  refunded: 'بازگردانده‌شده',
  collected: 'وصول‌شده',
  platformAdvance: 'پیش‌دادهٔ سکو',
  recoveredIn: 'بازیافتِ واردشده',
  platformEarned: 'درآمدِ سکو',
  providerFee: 'کارمزدِ درگاه',
  recoveryOut: 'بازیافتِ خارج‌شده',
};

/**
 * One figure.
 *
 * The wire field name is carried as `data-field` rather than rendered. In the
 * prototype it appears beside every amount, but there it is a design-review
 * annotation: a salon owner reading their own money gains nothing from the
 * word `platformAdvance`, and twelve Latin identifiers in an RTL column are
 * noise on a 390px screen. The field reference belongs in the amendment's own
 * caption table, where §A-6 puts it. Keeping it as an attribute costs nothing
 * and still lets a test target one card unambiguously.
 */
function FundAmount({ field, funds }: { field: FundField; funds: WorkspaceFunds }) {
  return (
    <div className="bc-fund-card" data-field={field}>
      <span style={{ fontSize: 13.5, color: 'var(--bc-color-ink-soft)' }}>{LABEL[field]}</span>
      <span style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{formatToman(funds[field])}</span>
    </div>
  );
}

/**
 * One group. `bounded` draws the block's own border and heading -- the
 * boundary is carried by text AND shape, never colour alone, so it survives
 * both a monochrome rendering and a reader who cannot distinguish the tint.
 */
function FundGroup({
  heading,
  note,
  fields,
  funds,
  bounded,
  marker,
}: {
  heading: string;
  note?: string;
  fields: readonly FundField[];
  funds: WorkspaceFunds;
  bounded?: boolean;
  marker?: 'circle' | 'diamond';
}) {
  const grid = (
    <div className="bc-fund-grid">
      {fields.map((field) => (
        <Card key={field}>
          <FundAmount field={field} funds={funds} />
        </Card>
      ))}
    </div>
  );

  const title = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap', marginBlockEnd: note ? 6 : 10 }}>
      {marker ? (
        <span
          aria-hidden="true"
          style={{
            width: 10,
            height: 10,
            flexShrink: 0,
            border: '2px solid var(--bc-color-ink-soft)',
            borderRadius: marker === 'circle' ? '50%' : 2,
            transform: marker === 'diamond' ? 'rotate(45deg)' : undefined,
          }}
        />
      ) : null}
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{heading}</h3>
    </div>
  );

  const body = (
    <>
      {title}
      {note ? (
        <p style={{ margin: '0 0 10px', fontSize: 12.5, lineHeight: 1.85, color: 'var(--bc-color-ink-soft)' }}>{note}</p>
      ) : null}
      {grid}
    </>
  );

  if (!bounded) return <section style={{ marginBlockEnd: 16 }}>{body}</section>;

  return (
    <section
      style={{
        marginBlockEnd: 16,
        padding: '16px 18px',
        borderRadius: 'var(--bc-radius-row)',
        border: '2px dashed var(--bc-color-ink-soft)',
        background: 'var(--bc-color-surface-tint)',
      }}
    >
      {body}
    </section>
  );
}

export function FundsByState({ funds }: { funds: WorkspaceFunds }) {
  const allZero = [...SELLER_STATES, ...CUSTODY_FACTS, ...PLATFORM_FACTS].every((field) => funds[field] === 0);

  return (
    <div data-testid="funds-by-state" style={{ marginBlockEnd: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>وجوه، وضعیت‌به‌وضعیت</h2>
      <p style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.85, color: 'var(--bc-color-ink-soft)' }}>
        این ارقام و سه رقمِ بالا <strong>به دو پرسشِ متفاوت پاسخ می‌دهند و با هم جمع نمی‌شوند</strong>. هیچ نسبتی میانشان محاسبه نمی‌شود.
      </p>

      {/* Not an empty state: the server answered, and the answer is zero. */}
      {allZero ? (
        <p role="note" style={{ margin: '0 0 14px', fontSize: 12.5, lineHeight: 1.85, color: 'var(--bc-color-ink-soft)' }}>
          در این فضا هنوز هیچ وجهی در هیچ وضعیتی ثبت نشده است. این پاسخِ درستِ سرور است، نه خطا و نه نبودِ اطلاعات.
        </p>
      ) : null}

      <FundGroup heading="وجوهِ این فضا" fields={SELLER_STATES} funds={funds} />

      <FundGroup
        heading="واقعیت‌های امانت و وضعِ نقدی — نه ماندهٔ شما"
        note="این سه رقم دربارهٔ سفارش‌های همین فضا واقعیت می‌گویند، اما هیچ‌کدام رقمِ قابلِ پرداخت به شما نیستند و به وضعیت‌های بالا افزوده نمی‌شوند."
        fields={CUSTODY_FACTS}
        funds={funds}
        bounded
        marker="circle"
      />

      <FundGroup
        heading="آن سوی مرز — پولِ سکو، نه پولِ شما"
        note="این سه رقم برای شفافیت نشان داده می‌شوند و به هیچ‌یک از ارقامِ بالا افزوده یا از آن‌ها کم نمی‌شوند."
        fields={PLATFORM_FACTS}
        funds={funds}
        bounded
        marker="diamond"
      />
    </div>
  );
}
