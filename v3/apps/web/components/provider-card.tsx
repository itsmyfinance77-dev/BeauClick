import Link from 'next/link';
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
 * The artwork is a placeholder. `avatarUrl` and `portfolioCount` are not in
 * the public search result at this baseline, and `bronze` simply alternates so
 * a long list does not read as one block of colour — which is why the caller
 * passes the row's index rather than the card deriving anything from it.
 */
export function ProviderCard({
  item,
  index,
  saving,
  onToggleSaved,
}: {
  item: SearchResultItem;
  /** Position in the list, for the alternating placeholder artwork only. */
  index: number;
  /** A save for THIS professional is in flight. */
  saving: boolean;
  onToggleSaved: () => void;
}) {
  const href = `/providers/${item.id}?from=search`;

  return (
    <article className={styles.card} data-provider={item.id}>
      <div className={`${styles.cardArt} ${index % 2 === 1 ? styles.cardArtBronze : ''}`} aria-hidden="true">
        <span className={styles.cardArtLabel}>نمونه کار</span>
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
