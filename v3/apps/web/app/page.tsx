'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toPersianDigits } from '@beauclick/persian-utils';
import { PriceDisplay } from '@/components/price-display';
import { ErrorState } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { searchProviders, type FacetBucket, type SearchResultItem } from '@/lib/phase3-api';
import styles from './home.module.css';

/**
 * The landing page — `Prototype - Customer.dc.html` §01, desktop 1280 and
 * mobile 390.
 *
 * What stood here was a 51-line placeholder card with three links, written in
 * Phase 1 and never replaced. This is the designed page.
 *
 * ## Everything with a number behind it comes from the server
 *
 * Two parallel reads, both of routes that already exist:
 *
 *  - `GET /v1/search/providers` unfiltered, for `facets.specialties` — the
 *    specialty names and the real count of professionals in each.
 *  - the same route with `verifiedOnly`, sorted by ranking, for the three
 *    cards under «متخصص‌های تأییدشده» — name, city, specialties, starting
 *    price and verification, all from `SearchResultItem`.
 *
 * ## Three things the design shows that are NOT rendered, and why
 *
 *  1. **A starting price on each specialty card.** The design's own data note
 *     calls this "derivable from the same facets, with no new API route".
 *     It would require an additional filtered read per card (or an extended
 *     facet), which this page does not issue. The card shows the count, which
 *     is real, and no price rather than a guessed one.
 *  2. **«پرجست‌وجوترین» as the label on the shortcut chips.** No search-volume
 *     data exists anywhere in the product. The chips are the specialties with
 *     the most professionals, and they are labelled as that.
 *  3. **A district under each professional's name** («یزد · صفاییه»). The
 *     contract carries `city` and nothing finer; the design marks the district
 *     as a placeholder for a future field. Only the city renders.
 *
 * Portfolio imagery is a deliberate placeholder rather than a gap. Since #226
 * the search response these cards are built from carries `images` and
 * `portfolioCount`, and `/search` draws them; this page still ships the
 * design's striped tiles, which its own artboard draws and #226 did not
 * change. Drawing the real avatar here is a separate, small piece of work, not
 * a missing fact.
 */

/** How many specialty cards the grid holds — four on desktop, two rows of two on a phone. */
const CATEGORY_COUNT = 4;

/** How many professionals the «تأییدشده» section shows. */
const PROVIDER_COUNT = 3;

const STEPS = [
  {
    title: 'خدمت را انتخاب کنید',
    text: 'قیمت و مدت هر خدمت پیش از رزرو مشخص است. مبلغ نهایی را سرور محاسبه می‌کند.',
  },
  {
    title: 'زمان آزاد را بردارید',
    text: 'زمان‌ها به وقت تهران و واقعی‌اند. تا پرداخت نشود، زمان برای شما نگه داشته می‌شود.',
  },
  {
    title: 'پرداخت و تأیید',
    text: 'پس از پرداخت، رسید و زمان نوبت در «رزروهای من» ثبت می‌شود و اعلان می‌گیرید.',
  },
] as const;

interface HomeData {
  specialties: FacetBucket[];
  /** The single city the platform serves, when the facets report exactly one. */
  soleCity: string | null;
  verified: SearchResultItem[];
}

function searchHref(term: string): string {
  return `/search?q=${encodeURIComponent(term)}`;
}

function specialtyHref(id: string): string {
  return `/search?specialtyIds=${encodeURIComponent(id)}`;
}

export default function HomePage() {
  const { api } = useAuth();
  const router = useRouter();

  const [term, setTerm] = useState('');
  const [data, setData] = useState<HomeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [all, verified] = await Promise.all([
        searchProviders(api, { page: 1 }),
        searchProviders(api, { verifiedOnly: true, sort: 'ranking', page: 1 }),
      ]);
      const cities = all.data?.facets.cities ?? [];
      setData({
        specialties: [...(all.data?.facets.specialties ?? [])]
          .sort((a, b) => b.count - a.count)
          .slice(0, CATEGORY_COUNT),
        // Named only when there is exactly one: the badge claims the platform
        // serves one city, and that claim has to stop being made the moment
        // it stops being true.
        soleCity: cities.length === 1 ? (cities[0].label ?? cities[0].key) : null,
        verified: (verified.data?.items ?? []).slice(0, PROVIDER_COUNT),
      });
    } catch {
      setError('بارگذاری صفحه ممکن نشد. اتصال اینترنت خود را بررسی کنید.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    router.push(term.trim() ? searchHref(term.trim()) : '/search');
  }

  const city = data?.soleCity ?? null;

  return (
    <>
      <section className={styles.hero}>
        <div className={styles.heroInner}>
          <div>
            {city ? (
              <div className={styles.localityBadge}>
                <span className={styles.localityDot} aria-hidden="true" />
                {city} و به‌زودی سراسر ایران
              </div>
            ) : null}

            <h1 className={styles.heroTitle}>متخصص زیبایی‌تان را با اطمینان انتخاب کنید</h1>
            <p className={styles.heroLead}>
              قیمت‌ها پیش از رزرو مشخص است، زمان‌ها واقعی‌اند و هویت متخصص‌ها بررسی می‌شود. پرداخت پس از انتخاب زمان، در
              همان صفحه.
            </p>

            <form className={styles.searchBox} onSubmit={submitSearch} role="search">
              <div className={styles.searchField}>
                <span className={styles.searchGlyph} aria-hidden="true" />
                <label className="bc-visually-hidden" htmlFor="home-search">
                  جست‌وجوی خدمت
                </label>
                <input
                  id="home-search"
                  className={styles.searchInput}
                  value={term}
                  onChange={(event) => setTerm(event.target.value)}
                  placeholder="چه خدمتی می‌خواهید؟ مثلاً میکاپ عروس"
                />
              </div>
              <div className={styles.searchDivider} aria-hidden="true" />
              {/*
                The city control is present because the design has it, and it
                is a LINK to the full search rather than a selector: the
                platform serves one city, and a picker with one option that
                cannot change is a control that lies about what it does.
              */}
              {city ? (
                <Link href="/search" className={styles.cityButton}>
                  {city}
                  <span className={styles.cityChevron} aria-hidden="true" />
                </Link>
              ) : null}
              <button type="submit" className={styles.searchSubmit}>
                {city ? `جست‌وجو در ${city}` : 'جست‌وجو'}
              </button>
            </form>

            {data && data.specialties.length > 0 ? (
              <div className={styles.termRow} data-testid="popular-specialties">
                <span className={styles.termLabel}>تخصص‌های پرتکرار:</span>
                {data.specialties.map((specialty) => (
                  <Link
                    key={specialty.key}
                    href={specialtyHref(specialty.key)}
                    className={styles.term}
                  >
                    {specialty.label ?? specialty.key}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          {/* Placeholders, labelled as such — the media pipeline is phase C. */}
          <div className={styles.heroArt} aria-hidden="true">
            <div className={`${styles.artTile} ${styles.artTileWide}`}>
              <span className={styles.artLabel}>تصویر قهرمان — کار واقعی یک متخصص</span>
            </div>
            <div className={styles.artTile}>
              <span className={styles.artLabel}>نمونه کار</span>
            </div>
            <div className={`${styles.artTile} ${styles.artTileBronze}`}>
              <span className={styles.artLabel}>نمونه کار</span>
            </div>
          </div>
        </div>
      </section>

      {error ? (
        <section className={styles.section}>
          <div className={styles.sectionInner}>
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        </section>
      ) : null}

      {!error && (data === null || data.specialties.length > 0) ? (
        <section className={styles.section}>
          <div className={styles.sectionInner}>
            <div className={styles.sectionHead}>
              <div>
                <h2 className={styles.sectionTitle}>از کجا شروع کنیم؟</h2>
                <p className={styles.sectionLead}>
                  تخصص‌های ثبت‌شده متخصص‌ها، با شمار متخصصِ هر تخصص.
                </p>
              </div>
              <Link href="/search" className={styles.sectionLink}>
                همه خدمات
              </Link>
            </div>

            <div className={styles.categoryGrid} data-testid="specialty-grid">
              {data === null
                ? Array.from({ length: CATEGORY_COUNT }, (_, i) => (
                    <div key={i} className={styles.skeletonCard} data-testid="specialty-skeleton">
                      <div className={styles.categoryArt} />
                      <div className={styles.skeletonLines}>
                        <div className={styles.skeletonLine} />
                        <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
                      </div>
                    </div>
                  ))
                : data.specialties.map((specialty, index) => {
                    const name = specialty.label ?? specialty.key;
                    return (
                      <Link
                        key={specialty.key}
                        href={specialtyHref(specialty.key)}
                        className={styles.categoryCard}
                        data-specialty={specialty.key}
                      >
                        <div
                          className={`${styles.categoryArt} ${index % 2 === 1 ? styles.categoryArtBronze : ''}`}
                          aria-hidden="true"
                        />
                        <div className={styles.categoryBody}>
                          <div className={styles.categoryName}>{name}</div>
                          <div className={styles.categoryMeta}>{toPersianDigits(specialty.count)} متخصص</div>
                        </div>
                      </Link>
                    );
                  })}
            </div>
          </div>
        </section>
      ) : null}

      {!error ? (
        <section className={`${styles.section} ${styles.sectionOnSurface}`}>
          <div className={styles.sectionInner}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>متخصص‌های تأییدشده</h2>
              <Link href="/providers" className={styles.sectionLink}>
                همه متخصص‌ها
              </Link>
            </div>

            {data === null ? (
              <div className={styles.providerGrid}>
                {Array.from({ length: PROVIDER_COUNT }, (_, i) => (
                  <div key={i} className={styles.skeletonCard} data-testid="provider-skeleton">
                    <div className={styles.skeletonArt} />
                    <div className={styles.skeletonLines}>
                      <div className={styles.skeletonLine} />
                      <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
                    </div>
                  </div>
                ))}
              </div>
            ) : data.verified.length === 0 ? (
              /* Said plainly, not hidden: an empty section with a heading is
                 a claim that the list is empty, and it should read as one. */
              <p className={styles.stateBlock}>هنوز متخصص تأییدشده‌ای در دسترس نیست.</p>
            ) : (
              <div className={styles.providerGrid} data-testid="verified-providers">
                {data.verified.map((provider, index) => (
                  <article key={provider.id} className={styles.providerCard} data-provider={provider.id}>
                    <div
                      className={`${styles.providerArt} ${index % 2 === 1 ? styles.providerArtBronze : ''}`}
                    >
                      {provider.isVerified ? <span className={styles.verifiedBadge}>تأیید شده</span> : null}
                    </div>
                    <div className={styles.providerBody}>
                      <div>
                        <div className={styles.providerName}>{provider.displayName}</div>
                        {provider.city ? <div className={styles.providerPlace}>{provider.city.name}</div> : null}
                      </div>
                      {provider.specialties.length > 0 ? (
                        <div className={styles.providerSpecialties}>{provider.specialties.join('، ')}</div>
                      ) : null}
                      <div className={styles.providerFoot}>
                        <div>
                          {provider.priceFromToman === null ? (
                            /* No published service carries a price yet. The
                               design's card always shows one; showing zero or
                               a dash beside "شروع از" would both read as a
                               price, so the label goes too. */
                            <div className={styles.priceLabel}>قیمت هنوز اعلام نشده</div>
                          ) : (
                            <>
                              <div className={styles.priceLabel}>شروع از</div>
                              <div className={styles.priceValue}>
                                <PriceDisplay amount={provider.priceFromToman} /> <span className={styles.priceUnit}>تومان</span>
                              </div>
                            </>
                          )}
                        </div>
                        <Link href={`/providers/${provider.id}`} className={styles.providerAction}>
                          زمان‌های آزاد
                        </Link>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionInner}>
          <h2 className={`${styles.sectionTitle} ${styles.sectionTitleSpaced}`}>رزرو در سه قدم</h2>
          <div className={styles.stepGrid}>
            {STEPS.map((step, index) => (
              <div key={step.title} className={styles.step}>
                <div className={styles.stepNumber} aria-hidden="true">
                  {toPersianDigits(index + 1)}
                </div>
                <h3 className={styles.stepTitle}>{step.title}</h3>
                <p className={styles.stepText}>{step.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
