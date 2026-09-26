import type { ChatRefusalReason, ChatSide } from '@beauclick/chat-contract';

/**
 * Words for the chat surfaces — `36_INTERNAL_CHAT.md` and `Prototype - Customer` §18.
 *
 * A refusal the server RETURNS is shown in the server's own sentence
 * (`chatRefusalOf`). This file covers the one place no server sentence
 * arrives: `cannotSendReason` on a conversation summary, which is a reason
 * code only. The copy is the server's own for the same reason
 * (`services/chat/src/chat.exceptions.ts`), and the spec's for the seller's
 * shorter variants. `Record<ChatRefusalReason, …>` makes a new reason a type
 * error here until it has words.
 */
const CANNOT_SEND: Record<ChatRefusalReason, { customer: string; seller: string }> = {
  not_eligible: {
    customer: 'برای گفتگو با این ارائه‌دهنده، باید رزرو تأییدشده‌ای با او داشته باشید.',
    seller: 'امکان ارسال پیام در این گفتگو وجود ندارد.',
  },
  send_window_closed: {
    customer: 'مهلت ارسال پیام برای این گفتگو به پایان رسیده است. با ثبت رزرو جدید دوباره می‌توانید پیام بفرستید.',
    seller: 'مهلت ارسال پیام برای این گفتگو به پایان رسیده است.',
  },
  // One sentence for the blocker and the blocked: direction is never shown (V32-DEC-014).
  blocked: {
    customer: 'امکان ارسال پیام در این گفتگو وجود ندارد.',
    seller: 'امکان ارسال پیام در این گفتگو وجود ندارد.',
  },
  conversation_closed: {
    customer: 'این گفتگو توسط تیم پشتیبانی بسته شده است و امکان ارسال پیام تازه ندارد.',
    seller: 'این گفتگو توسط تیم پشتیبانی بسته شده است.',
  },
  sender_restricted: {
    customer: 'امکان ارسال پیام برای حساب شما محدود شده است.',
    seller: 'امکان ارسال پیام برای حساب شما محدود شده است.',
  },
  message_too_long: {
    customer: 'پیام شما خالی است یا از حد مجاز طولانی‌تر است.',
    seller: 'پیام شما خالی است یا از حد مجاز طولانی‌تر است.',
  },
  rate_limited: {
    customer: 'تعداد پیام‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
    seller: 'تعداد پیام‌های شما بیش از حد مجاز است. کمی بعد دوباره تلاش کنید.',
  },
  report_already_open: {
    customer: 'گزارش قبلی شما برای این گفتگو هنوز در حال بررسی است.',
    seller: 'گزارش قبلی شما برای این گفتگو هنوز در حال بررسی است.',
  },
  report_rate_limited: {
    customer: 'تعداد گزارش‌های شما در ۲۴ ساعت گذشته بیش از حد مجاز است.',
    seller: 'تعداد گزارش‌های شما در ۲۴ ساعت گذشته بیش از حد مجاز است.',
  },
};

export function cannotSendCopy(reason: ChatRefusalReason, side: ChatSide): string {
  return CANNOT_SEND[reason][side];
}

/**
 * What a business counterparty is called. No public business summary exists
 * (spec 36: BACKEND CONTRACT REQUIRED), so every salon is this neutral label —
 * never an invented name, and never the booked practitioner's.
 */
export const BUSINESS_COUNTERPARTY_LABEL = 'کسب‌وکار BeauClick';

/** What a seller-side reader calls the other party. The summary carries no customer identity. */
export const CUSTOMER_LABEL = 'مشتری';

/** An erased author's placeholder (V32-DEC-013): no excerpt, no length, nothing reconstructable. */
export const ERASED_MESSAGE = 'این پیام حذف شده است.';
export const ERASED_AUTHOR = 'کاربر حذف‌شده';

export const CHAT_GONE = 'این گفتگو دیگر در دسترس نیست.';
