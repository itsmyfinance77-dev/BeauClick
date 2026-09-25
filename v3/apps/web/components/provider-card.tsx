'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import type { SearchResultItem } from '@/lib/phase3-api';
import { PriceDisplay } from './price-display';
import styles from './provider-card.module.css';

/**
 * One professional in a list of search results —
 * `V3_COMPONENT_INVENTORY.md`'s `ProviderCard`, `01_SEARCH.md`.
 *
 * `saved === null` is not "not saved": there is no caller for the server to
 * answer about, so the card offers a link to sign in rather than a control
 * that would claim an anonymous visitor has not saved anything. Three states,
 * not two — the type in `phase3-api.ts` says the same thing.
 *
 * A professional with no priced service yet gets «قیمت هنوز اعلام نشده» and
 * NO «شروع از» label: a zero or a dash beside that label would both read as a
 * price, so the label goes with the figure.
 *
 * ## The artwork is the professional's own, or an honest absence (#226)
 *
 * `01_SEARCH.md`: the avatar in the card's corner, «۳ نمونه» over it when there
 * is portfolio, and — for the many professionals with neither — a real no-image
 * state "rather than one identical placeholder for everyone". The card used to
 * draw the design's striped tile for every result, which is exactly that
 * placeholder.
 *
 * - **An avatar** is drawn from `images.avatar.url`, with its own dimensions so
 *   the space is reserved before it loads.
 * - **No avatar** is a dashed, neutral box that SAYS what is missing — «بدون
 *   نمونه کار» when there is no portfolio either, «بدون تصویر» when there is
 *   work but no photo. Nothing is invented to fill it.
 * - **An image that fails to load** falls back to that same box. A broken-image
 *   glyph is not a state, and the professional's name and the link stay usable
 *   regardless.
 * - **The count** is `portfolioCount` as the server sent it, shown only when it
 *   is above zero; a «۰ نمونه» badge would be noise on the many cards that
 *   have none. It is text, so it survives greyscale and a screen reader.
 */
export function ProviderCard({
  item,
  saving,
  onToggleSaved,
}: {
  item: SearchResultItem;
  /** A save for THIS professional is in flight. */
  saving: boolean;
  onToggleSaved: () => void;
}) {
  const href = `/providers/${item.id}?from=search`;
  // Tolerant of a server one release behind this client: the fields are
  // always present in the current contract, and their absence reads as "none".
  const avatar = item.images?.avatar ?? null;
  const portfolioCount = item.portfolioCount ?? 0;
  // The URL that failed, not a boolean, so a professional who replaces their
  // avatar is given a fresh chance without remounting the card.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const picture = avatar?.url && avatar.url !== failedUrl ? { ...avatar, url: avatar.url } : null;

  return (
    <article className={styles.card} data-provider={item.id}>
      <div className={`${styles.cardArt} ${picture ? '' : styles.cardArtEmpty}`} data-testid="card-art">
        {picture ? (
          /* A media-pipeline URL whose host is deployment-dependent, so `next/image`
             would need a configured remote pattern; the intrinsic size is passed so
             the box is reserved before the bytes arrive. */
          <img
            src={picture.url}
            alt={`تصویر ${item.displayName}`}
            width={picture.width ?? undefined}
            height={picture.height ?? undefined}
            className={styles.cardImage}
            loading="lazy"
            decoding="async"
            onError={() => setFailedUrl(picture.url)}
          />
        ) : (
          <span className={styles.cardArtLabel}>{portfolioCount > 0 ? 'بدون تصویر' : 'بدون نمونه کار'}</span>
        )}
        {portfolioCount > 0 ? (
          <span className={styles.portfolioBadge} data-testid="portfolio-count">
            <span aria-hidden="true">{toPersianDigits(portfolioCount)} نمونه</span>
            <span className="bc-visually-hidden">{toPersianDigits(portfolioCount)} نمونه‌کار</span>
          </span>
        ) : null}
      </div>

      <div className={styles.cardBody}>
        <div>
          <div className={styles.nameRow}>
            <h2 className={styles.cardName}>
              <Link href={href}>{item.displayName}</Link>
            </h2>
            {item.isVerified ? (
              <span className={styles.verified}>
                <span className={styles.verifiedDot} aria-hidden="true" />
                تأیید شده
              </span>
            ) : null}
            {item.saved === null ? (
              <Link
                href="/auth"
                className={`${styles.save} bc-tap`}
                aria-label={`برای ذخیرهٔ ${item.displayName} وارد شوید`}
              >
                ذخیره<span className={styles.saveSuffix}> در علاقه‌مندی‌ها</span>
              </Link>
            ) : (
              <button
                type="button"
                className={`${styles.save} ${item.saved ? styles.saveOn : ''} bc-tap`}
                aria-pressed={item.saved}
                disabled={saving}
                aria-label={
                  item.saved
                    ? `حذف ${item.displayName} از علاقه‌مندی‌ها`
                    : `افزودن ${item.displayName} به علاقه‌مندی‌ها`
                }
                onClick={onToggleSaved}
              >
                {item.saved ? (
                  'در علاقه‌مندی‌ها'
                ) : (
                  <>
                    ذخیره<span className={styles.saveSuffix}> در علاقه‌مندی‌ها</span>
                  </>
                )}
              </button>
            )}
          </div>
          {item.city ? <div className={styles.cardPlace}>{item.city.name}</div> : null}
        </div>

        {item.bio ? <p className={styles.cardBio}>{item.bio}</p> : null}

        {item.specialties.length > 0 ? (
          <div className={styles.tagRow}>
            {item.specialties.map((specialty) => (
              <span key={specialty} className={styles.tag}>
                {specialty}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className={styles.cardFoot}>
        <div>
          {item.priceFromToman === null ? (
            <div className={styles.priceLabel}>قیمت هنوز اعلام نشده</div>
          ) : (
            <>
              <div className={styles.priceLabel}>شروع از</div>
              <div className={styles.priceValue}>
                <PriceDisplay amount={item.priceFromToman} /> <span className={styles.priceUnit}>تومان</span>
              </div>
            </>
          )}
        </div>
        <Link href={href} className={styles.cardAction}>
          دیدن زمان‌ها
        </Link>
      </div>
    </article>
  );
}
