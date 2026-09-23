import Link from 'next/link';
import { toPersianDigits } from '@beauclick/persian-utils';
import type { ServiceOffering } from '@/lib/booking-api';
import { PriceDisplay } from './price-display';
import styles from './service-row.module.css';

/**
 * One bookable service on a professional's profile —
 * `V3_COMPONENT_INVENTORY.md`'s `ServiceRow`, `02_PROVIDER_PROFILE.md`.
 *
 * The whole row selects, so the target is the card rather than a word inside
 * it, and the chosen row carries a 2px border AND the «انتخاب شد» chip —
 * a border alone would be a colour-only signal.
 *
 * `saved === null` is not "not saved": it is an anonymous visitor, about whom
 * the server can say nothing. That case offers a link to sign in rather than
 * an unsaved-looking control, because rendering one would claim a fact about
 * somebody the server cannot identify.
 *
 * Saving a service is independent of saving the professional; the page says so
 * in the note under the list.
 */
export function ServiceRow({
  service,
  chosen,
  saved,
  busy,
  onSelect,
  onToggleSaved,
}: {
  service: ServiceOffering;
  chosen: boolean;
  /** `null` for a signed-out visitor — unknown, not false. */
  saved: boolean | null;
  /** A save for THIS service is in flight. */
  busy: boolean;
  onSelect: () => void;
  /** Carries the state being toggled AWAY from, which is a boolean by the
      time this fires: the control only exists when `saved` is not null. */
  onToggleSaved: (currentlySaved: boolean) => void;
}) {
  return (
    <div
      className={`${styles.service} ${chosen ? styles.serviceChosen : ''}`}
      data-service={service.id}
      data-chosen={chosen ? 'true' : undefined}
    >
      <button type="button" onClick={onSelect} aria-pressed={chosen} className={styles.serviceSelectButton}>
        <span className={styles.serviceHead}>
          <span className={styles.serviceName}>{service.name}</span>
          {chosen ? <span className={styles.chosenChip}>انتخاب شد</span> : null}
        </span>
        <span className={`${styles.serviceMeta} ${styles.serviceMetaBlock}`}>
          {toPersianDigits(service.durationMinutes)} دقیقه
        </span>
      </button>
      <div className={styles.servicePrice}>
        <div>
          <div className={styles.priceValue}>
            <PriceDisplay amount={service.priceToman} />
          </div>
          <div className={styles.priceUnit}>تومان</div>
        </div>
        {saved === null ? (
          <Link href="/auth" className={`${styles.serviceSave} bc-tap`} aria-label={`برای ذخیرهٔ ${service.name} وارد شوید`}>
            ذخیره
          </Link>
        ) : (
          <button
            type="button"
            className={`${styles.serviceSave} ${saved ? styles.serviceSaveOn : ''} bc-tap`}
            aria-pressed={saved}
            disabled={busy}
            aria-label={saved ? `حذف ${service.name} از علاقه‌مندی‌ها` : `افزودن ${service.name} به علاقه‌مندی‌ها`}
            onClick={() => onToggleSaved(saved)}
          >
            {saved ? 'ذخیره‌شده' : 'ذخیره'}
          </button>
        )}
      </div>
    </div>
  );
}
