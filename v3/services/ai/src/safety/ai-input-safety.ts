import { AI_MAX_INPUT_CHARACTERS, aiInputLength } from '@beauclick/ai-contract';

/**
 * Input screening — the control that runs BEFORE a provider is invoked
 * (ADR-030 T1, T2).
 *
 * ## The ordering is the point
 *
 * `V3_SECURITY_MODEL.md` §5 requires the check to happen before the provider is
 * called, and everything here is pure and synchronous precisely so that
 * ordering is structural: there is nothing to await, so nothing to accidentally
 * fire in parallel with the completion.
 *
 * ## What this is, and what it is not
 *
 * **It is a mitigation, not the defence.** V2 shipped a six-phrase list, and
 * `V3.2_PHASE_0_DISCOVERY.md` §7.3 is explicit that it needs re-auditing rather
 * than mechanical porting. A phrase list is defeated by paraphrase — that is
 * not a bug in the list, it is what a phrase list is.
 *
 * The defence is that a successful injection has nothing to reach. The context
 * contains no other customer's data, no secret, no credential, no internal
 * identifier, and no free text; the provider holds no database handle and can
 * generate no query; and every id it names is re-verified before anything is
 * shown. A bypassed phrase list costs a refusal that should have happened. It
 * does not cost data.
 *
 * That is why this file is short and why it does not try to be clever. An
 * elaborate classifier here would buy very little and would invite the belief
 * that the boundary is enforced at this layer, which is exactly the belief
 * ADR-030 exists to prevent.
 *
 * ## Normalisation comes first, and is not optional
 *
 * A filter defeated by a zero-width non-joiner is decoration. Persian text is
 * full of legitimate ZWNJ (`‌`) — it is how half-spaces are written — so
 * an attacker padding `ignore previous instructions` with them is producing
 * something that looks entirely normal in a Persian input field. Same for
 * Arabic-Indic and Persian digit forms, and for the Arabic ye/kaf that Persian
 * keyboards produce interchangeably with the Persian ones.
 *
 * So screening runs on a canonicalised copy: NFKC, Persian/Arabic letter
 * unification, digit folding, zero-width removal, and whitespace collapse. The
 * canonical form is used ONLY for matching. What is stored, if the message is
 * accepted, is the customer's original text — normalised to NFC and trimmed,
 * and nothing else. Storing the canonical form would silently rewrite what
 * somebody wrote.
 */

/** Zero-width and bidirectional control characters, removed before matching. */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

/** Arabic-Indic and Persian digits, folded to ASCII so `1gnore`-style padding gains nothing. */
const DIGIT_FOLD: Readonly<Record<string, string>> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/**
 * Arabic and Persian letters that a Persian keyboard produces interchangeably.
 *
 * `ي`/`ی` and `ك`/`ک` are the two that matter: the Arabic forms are what many
 * keyboards and copy-pastes emit, and a pattern written with one form and text
 * typed with the other simply does not match. This is the single most common
 * way a Persian-language filter silently stops working.
 */
const LETTER_FOLD: Readonly<Record<string, string>> = { 'ي': 'ی', 'ك': 'ک', 'ۀ': 'ه', 'ة': 'ه', 'أ': 'ا', 'إ': 'ا', 'آ': 'ا' };

/** The form patterns are matched against. Never stored, never shown, never sent to a provider. */
export function canonicalizeForScreening(text: string): string {
  let out = text.normalize('NFKC').replace(INVISIBLE, '');
  out = [...out].map((ch) => DIGIT_FOLD[ch] ?? LETTER_FOLD[ch] ?? ch).join('');
  return out.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Instruction-override attempts, in both languages the product is used in.
 *
 * ## Every pattern below is written in the CANONICAL alphabet
 *
 * This is the rule most likely to be broken by the next person to add one, and
 * it was broken during this file's own development: a pattern containing `آن`
 * matched nothing, because `canonicalizeForScreening` folds `آ` to `ا` before
 * matching, so the text being tested had already become `ان`. The pattern was
 * correct Persian and entirely dead.
 *
 * So: no `آ`, `أ`, `إ` (write `ا`), no `ة`, `ۀ` (write `ه`), no `ي` (write `ی`),
 * no `ك` (write `ک`), no Persian or Arabic-Indic digits (write ASCII), and
 * nothing uppercase. `ai-input-safety.spec.ts` asserts this mechanically over
 * both lists, so a non-canonical pattern fails the suite rather than silently
 * never firing.
 *
 * Note also that JavaScript's `` is ASCII-based and does NOT recognise a
 * boundary after a Persian letter -- `یک` never matches. Use `\s` or nothing.
 *
 * Written as regular expressions with `\s*` between words rather than literal
 * strings, so `ignore    all   previous  instructions` and its zero-width-padded
 * cousin both match after canonicalisation.
 *
 * Each entry earns its place by being a phrasing that has no legitimate use in
 * a question about beauty services. `"سیستم"` alone would not qualify — a
 * customer may reasonably use the word — which is why the patterns are phrases
 * about instructions and roles rather than keywords.
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  // ---- instruction override, English
  /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instruction|prompt|rule|direction)/,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)/,
  /forget\s+(everything|all)\s+(you|above|before)/,
  /(reveal|show|print|repeat|output|display)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instruction|rule)/,
  /you\s+are\s+now\s+(a|an|in)\b/,
  /(developer|debug|god|admin|jailbreak)\s*mode/,
  /\bact\s+as\s+(a|an)\s+(admin|administrator|system|developer|operator)/,
  /new\s+(system\s+)?(instruction|prompt)s?\s*:/,
  /<\s*\/?\s*(system|assistant|user)\s*>/,

  // ---- instruction override, Persian
  /دستور(ات|های)?\s*(قبلی|بالا|پیشین)\s*(را)?\s*(نادیده|فراموش|رها)/,
  /(نادیده\s*بگیر|فراموش\s*کن)\s*(هر\s*)?(چه|انچه)/,
  /(پرامپت|دستورالعمل)\s*(سیستم|سیستمی)/,
  /(از\s*این\s*(به\s*بعد|پس)|از\s*حالا)\s*تو\s*(یک|یه)\s/,
  /نقش\s*(مدیر|ادمین|سیستم|توسعه\s*دهنده)/,
  /حالت\s*(توسعه|دیباگ|ادمین|بدون\s*محدودیت)/,
];

/**
 * Requests for somebody else's private data (ADR-030 T2).
 *
 * Refused EXPLICITLY rather than answered with a shrug. An assistant that
 * quietly says "I don't know" to these teaches a user to rephrase until it
 * doesn't — and the whole reason the context is curated is so that rephrasing
 * cannot eventually work. Saying no is both more honest and better security
 * hygiene.
 *
 * Deliberately narrow. `"چقدر درآمد دارم"` — the customer asking about their
 * own spending — must NOT match; the patterns are about ANOTHER party, so they
 * are anchored on possessives and third-party nouns rather than on the topic.
 */
export const PRIVATE_DATA_PATTERNS: readonly RegExp[] = [
  // ---- English
  /(other|another|previous|last)\s+(user|customer|client|person)('s)?\s+(message|conversation|chat|data|info|detail|phone|number)/,
  /(phone|mobile|contact|email|address)\s+(number\s+)?(of|for)\s+(the\s+)?(professional|provider|doctor|salon|customer|user)/,
  /(how much|what)\s+(does|do|did)\s+.{0,40}\s+(earn|make|charge internally|get paid)/,
  /(revenue|earnings|income|settlement|payout|commission)\s+(of|for)\s+/,
  /(show|list|give|dump)\s+(me\s+)?(all\s+|every\s+)?(users|customers|phone numbers|emails|conversations)/,
  /(verification|identity)\s+(document|evidence|card)/,

  // ---- Persian
  /(شماره|تلفن|موبایل|ایمیل|ادرس)\s*(تماس\s*)?(ی|های)?\s*(ان|این|فلان)?\s*(متخصص|سالن|پزشک|کاربر|مشتری)/,
  /(درامد|فروش|تسویه|کمیسیون|سود)\s*(ی|های)?\s*(ان|این|فلان)?\s*(متخصص|سالن|پزشک|کسب\s*و\s*کار)/,
  /(پیام|گفتگو|مکالمه)\s*(های)?\s*(کاربر|مشتری)\s*(دیگر|قبلی|بعدی)/,
  /(لیست|فهرست)\s*(همه\s*)?(کاربران|مشتریان|شماره\s*ها|ایمیل\s*ها)/,
  /(مدارک|مستندات)\s*(احراز\s*هویت|هویتی)/,
];

/**
 * Why a message was refused before reaching a provider.
 *
 * Both injection and private-data refusals surface to the browser as ONE
 * reason (`unsafe_request`), because telling somebody probing the boundary
 * which of their two techniques was detected tells them how to rephrase. The
 * distinction is kept HERE so an operator's counter can show which is rising,
 * and it never leaves the server.
 */
export type AiInputVerdict =
  | { readonly outcome: 'accepted'; readonly normalized: string }
  | { readonly outcome: 'too_long' }
  | { readonly outcome: 'empty' }
  | { readonly outcome: 'injection' }
  | { readonly outcome: 'private_data_request' };

/**
 * Screens one customer message.
 *
 * Pure, synchronous, and total — every path returns a verdict, and there is no
 * way to reach a provider without having gone through it.
 *
 * The accepted `normalized` value is the customer's own text, NFC-normalised
 * and trimmed. It is not the canonical screening form: storing that would mean
 * quietly rewriting what somebody wrote, folding their ye and their half-spaces
 * into shapes they did not type, and then handing that back to them in an
 * export as though it were theirs.
 */
export function screenCustomerInput(raw: string): AiInputVerdict {
  const normalized = raw.normalize('NFC').trim();
  if (normalized.length === 0) return { outcome: 'empty' };
  if (aiInputLength(normalized) > AI_MAX_INPUT_CHARACTERS) return { outcome: 'too_long' };

  const canonical = canonicalizeForScreening(normalized);

  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(canonical)) return { outcome: 'injection' };
  }
  for (const pattern of PRIVATE_DATA_PATTERNS) {
    if (pattern.test(canonical)) return { outcome: 'private_data_request' };
  }

  return { outcome: 'accepted', normalized };
}

/** True for the two verdicts the browser is told about as one `unsafe_request`. */
export function isUnsafeVerdict(verdict: AiInputVerdict): boolean {
  return verdict.outcome === 'injection' || verdict.outcome === 'private_data_request';
}

/**
 * The Persian refusal shown for an unsafe request.
 *
 * One message for both cases, for the reason above. It says what the assistant
 * is for rather than what it detected — a refusal that describes the filter is
 * a refusal that teaches the filter.
 */
export const UNSAFE_REQUEST_MESSAGE =
  'این درخواست خارج از کاری است که دستیار می‌تواند انجام دهد. دستیار فقط برای پیدا کردن خدمات و متخصص‌های عمومی ثبت‌شده در بیوکلیک است و به اطلاعات خصوصی هیچ کاربر یا کسب‌وکاری دسترسی ندارد.';

/**
 * How many earlier turns travel to the provider.
 *
 * Bounded, and small. `GAP-12` is the record of what unbounded costs: an
 * accumulating context is an unbounded prompt, an unbounded bill, and an
 * unbounded injection surface, because a sentence typed weeks ago is replayed
 * on every subsequent turn. Six turns is roughly three exchanges — enough for a
 * follow-up question to make sense, short enough that yesterday's message is
 * not still being sent today.
 */
export const AI_CONTEXT_HISTORY_TURNS = 6;
