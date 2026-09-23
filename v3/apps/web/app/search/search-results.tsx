'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { Alert, ErrorState } from '@/components/ui';
import { saveFailureMessage } from '@/lib/wishlist-api';
import {
  autocomplete,
  removeFromWishlist,
  saveToWishlist,
  searchProviders,
  type SearchParams,
  type SearchResponse,
  type SearchResultItem,
} from '@/lib/phase3-api';
import styles from './search.module.css';

/**
 * Search results — `Prototype - Customer.dc.html` §03 / §04 and
 * `docs/design/screens/01_SEARCH.md`.
 *
 * ## The change this screen is really about
 *
 * Seven identical pills in one row, where three of them were a multi-select
 * filter and four were a one-of-many sort. `V3_DESIGN_SYSTEM.md` §7 calls the
 * separation necessary, and the spec repeats it: "filter is multi-select with
 * checkboxes in a column; order is one-of-many in a dropdown; in today's code
 * the two are the same shape and must be separated."
 *
 * So: a filter column at 1024 and up, a bottom sheet below it, and a real
 * `<select>` for order. The shape of a control now tells you what it does.
 *
 * ## One design claim that does not hold at this baseline
 *
 * **`avatarUrl` and `portfolioCount` are not in the response.** The spec
 *     calls both "IMPLEMENTABLE NOW (phase C)", and `PublicProviderResult`
 *     carries neither. The card keeps the design's placeholder artwork and
 *     shows no «۳ نمونه» count.
 *
 * ## And one deliberate departure from the drawing
 *
 * The design draws price bands as CHECKBOXES. The server takes `minPrice` and
 * `maxPrice` — one range, not a set of bands — so multi-select would either
 * silently over-include a non-contiguous choice or quietly behave like a
 * single range. Bands are radios here. That is the same principle the design
 * is arguing for, applied to what the server can actually answer: the shape
 * of a control must match its semantics.
 *
 * ## The ARIA repair the spec makes a prerequisite
 *
 * "Fix the current violation: add onKeyDown (ArrowUp/Down/Enter/Escape),
 * `aria-activedescendant`, remove `<button>` from inside `role=option`
 * (an ARIA violation)." A button inside an option makes the option's own name
 * unreliable and leaves the listbox unusable from the keyboard. Done below,
 * before the visual work rather than after it.
 */

const SORTS = [
  { key: 'relevance', label: 'مرتبط‌ترین' },
  { key: 'ranking', label: 'برترین‌ها' },
  { key: 'price_asc', label: 'ارزان‌ترین' },
  { key: 'price_desc', label: 'گران‌ترین' },
] as const;

/**
 * The server's own band boundaries (`opensearch.adapter.ts`), mapped to the
 * `minPrice`/`maxPrice` pair it filters on. Duplicated deliberately and
 * pinned by a test: the facet keys are a public contract, and a silent change
 * to a boundary would make a label say one thing and the filter do another.
 */
const PRICE_BANDS: Record<string, { label: string; minPrice?: number; maxPrice?: number }> = {
  under_500k: { label: 'تا ۵۰۰ هزار تومان', maxPrice: 500_000 },
  '500k_1m': { label: '۵۰۰ هزار تا ۱ میلیون', minPrice: 500_000, maxPrice: 1_000_000 },
  '1m_2m': { label: '۱ تا ۲ میلیون', minPrice: 1_000_000, maxPrice: 2_000_000 },
  over_2m: { label: 'بیش از ۲ میلیون', minPrice: 2_000_000 },
};

/** Which band, if any, the current range corresponds to. */
function activeBand(params: SearchParams): string | null {
  for (const [key, band] of Object.entries(PRICE_BANDS)) {
    if (band.minPrice === params.minPrice && band.maxPrice === params.maxPrice) return key;
  }
  return null;
}

export function SearchResults() {
  const { api } = useAuth();
  /*
    The home page's hero field and its specialty shortcuts both navigate to
    `/search?q=…`, so the term has to survive the navigation. Read once, as
    the INITIAL state rather than as a synchronised value: after the page is
    open the input is the user's, and re-seeding it from a stale URL on a
    later render would overwrite what they are typing.
  */
  const urlParams = useSearchParams();
  const initialQuery = urlParams?.get('q')?.trim() ?? '';
  const initialSpecialtyIds = urlParams?.getAll('specialtyIds').filter(Boolean) ?? [];
  const [query, setQuery] = useState(initialQuery);
  const [params, setParams] = useState<SearchParams>({
    q: initialQuery || undefined,
    specialtyIds: initialSpecialtyIds.length > 0 ? initialSpecialtyIds : undefined,
    sort: 'relevance',
    page: 1,
  });
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  /** Ids whose save request is in flight, so a control cannot be double-fired. */
  const [savingIds, setSavingIds] = useState<ReadonlySet<string>>(new Set());
  // Why the last save was refused. A full list (409) is the one refusal the
  // customer can act on, and it used to vanish silently with the rest.
  const [saveError, setSaveError] = useState<string | null>(null);

  const listboxId = useId();

  // Guards against an out-of-order response overwriting a newer one: a slow
  // request for "می" must not replace the results for "میکاپ" typed after it.
  const requestSeq = useRef(0);

  const run = useCallback(
    async (next: SearchParams) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const res = await searchProviders(api, next);
        if (seq !== requestSeq.current) return;
        setResult(res.data);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        setError(err instanceof Error ? err.message : 'جست‌وجو انجام نشد.');
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void run(params);
  }, [params, run]);

  // Debounced autocomplete. 250ms is short enough to feel instant and long
  // enough that a typed word is not one request per keystroke.
  useEffect(() => {
    if (query.trim().length < 2) {
      setSuggestions([]);
      setHighlighted(-1);
      return;
    }
    const timer = setTimeout(() => {
      void autocomplete(api, query.trim())
        .then((res) => {
          setSuggestions((res.data?.suggestions ?? []).map((s) => s.text));
          setHighlighted(-1);
        })
        .catch(() => setSuggestions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, api]);

  function search(term: string) {
    setSuggestions([]);
    setHighlighted(-1);
    setParams((p) => ({ ...p, q: term.trim() || undefined, page: 1 }));
  }

  /**
   * The combobox's keyboard contract, which did not exist.
   *
   * Arrow keys move the highlight, Enter takes the highlighted suggestion or
   * submits what is typed, and Escape dismisses the list without clearing the
   * field — the sequence a listbox owes anyone who is not using a mouse.
   */
  function onFieldKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (suggestions.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlighted((i) => (i + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlighted((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setSuggestions([]);
      setHighlighted(-1);
    } else if (event.key === 'Enter' && highlighted >= 0) {
      event.preventDefault();
      const chosen = suggestions[highlighted];
      setQuery(chosen);
      search(chosen);
    }
  }

  function setBand(key: string | null) {
    const band = key ? PRICE_BANDS[key] : undefined;
    setParams((p) => ({ ...p, minPrice: band?.minPrice, maxPrice: band?.maxPrice, page: 1 }));
  }

  function toggleSpecialty(specialtyId: string) {
    setParams((current) => {
      const selected = new Set(current.specialtyIds ?? []);
      if (selected.has(specialtyId)) selected.delete(specialtyId);
      else selected.add(specialtyId);
      const specialtyIds = Array.from(selected);
      return { ...current, specialtyIds: specialtyIds.length > 0 ? specialtyIds : undefined, page: 1 };
    });
  }

  /**
   * Save and unsave, against the caller's own wishlist.
   *
   * `saved` is a tri-state and `null` is not "not saved" — it means there is
   * no caller to answer for. An anonymous visitor is sent to sign in rather
   * than having a save attempted and refused.
   */
  async function toggleSaved(item: SearchResultItem) {
    if (item.saved === null || savingIds.has(item.id)) return;
    const next = !item.saved;
    setSaveError(null);
    setSavingIds((ids) => new Set(ids).add(item.id));
    try {
      if (next) await saveToWishlist(api, 'professional', item.id);
      else await removeFromWishlist(api, 'professional', item.id);
      // Patched in place rather than by re-running the search: a full re-read
      // would reorder the list under the reader's cursor for a change that
      // affects exactly one card.
      setResult((current) =>
        current ? { ...current, items: current.items.map((i) => (i.id === item.id ? { ...i, saved: next } : i)) } : current,
      );
    } catch (err) {
      // The list is unchanged, so the control stays as it was: a failed save
      // must not leave a card claiming a state the server does not hold. But
      // the customer is told why, in the server's own words for a full list.
      setSaveError(saveFailureMessage(err));
    } finally {
      setSavingIds((ids) => {
        const rest = new Set(ids);
        rest.delete(item.id);
        return rest;
      });
    }
  }

  const band = activeBand(params);
  const activeFilters = [
    ...(params.specialtyIds ?? []).map((specialtyId) => {
      const facet = result?.facets.specialties.find((candidate) => candidate.key === specialtyId);
      const label = facet?.label ?? 'تخصص انتخاب‌شده';
      return {
        key: `specialty:${specialtyId}`,
        label,
        clear: () => toggleSpecialty(specialtyId),
      };
    }),
    ...(params.verifiedOnly ? [{ key: 'verified', label: 'فقط تأییدشده', clear: () => setParams((p) => ({ ...p, verifiedOnly: undefined, page: 1 })) }] : []),
    ...(band ? [{ key: 'band', label: PRICE_BANDS[band].label, clear: () => setBand(null) }] : []),
    ...(params.q ? [{ key: 'q', label: `«${params.q}»`, clear: () => { setQuery(''); search(''); } }] : []),
  ];

  const verifiedCount = result?.facets.verification.find((b) => b.key === 'verified')?.count ?? null;

  return (
    <section>
      <h1 className="bc-visually-hidden">جست‌وجوی متخصص</h1>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          search(query);
        }}
        role="search"
        className={styles.searchForm}
      >
        <label htmlFor="search-q" className="bc-visually-hidden">
          نام متخصص، خدمت یا شهر
        </label>
        <input
          id="search-q"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onFieldKeyDown}
          placeholder="مثلاً میکاپ عروس"
          autoComplete="off"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={highlighted >= 0 ? `${listboxId}-${highlighted}` : undefined}
          className={styles.searchInput}
        />
        {suggestions.length > 0 && (
          /*
            The option IS the interactive element. It used to contain a
            `<button>`, which is an ARIA violation: an option's accessible
            name becomes the button's, and the listbox stops being operable
            as a listbox. Click and keyboard both land here now.
          */
          <ul id={listboxId} role="listbox" aria-label="پیشنهادها" className={styles.suggestions}>
            {suggestions.map((text, index) => (
              <li
                key={text}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === highlighted}
                onMouseDown={(event) => {
                  event.preventDefault();
                  setQuery(text);
                  search(text);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`${styles.suggestion} ${index === highlighted ? styles.suggestionHighlighted : ''}`}
              >
                {text}
              </li>
            ))}
          </ul>
        )}
      </form>

      <div className={styles.layout}>
        {/* The scrim exists only while the panel is a sheet. */}
        <div
          className={sheetOpen ? styles.scrimOpen : styles.scrim}
          onClick={() => setSheetOpen(false)}
          aria-hidden="true"
        />

        <aside
          id="filter-panel"
          aria-label="فیلترها"
          className={`${styles.filters} ${sheetOpen ? '' : styles.filtersClosed}`}
          data-testid="filter-panel"
        >
          <div className={styles.filtersHead}>
            <h2 className={styles.filtersTitle}>فیلترها</h2>
            <button
              type="button"
              className={`${styles.clearAll} bc-tap`}
              disabled={activeFilters.length === 0}
              onClick={() => {
                setQuery('');
                setParams({ sort: params.sort, page: 1 });
              }}
            >
              پاک کردن
            </button>
          </div>

          <fieldset className={`${styles.group} ${styles.groupFirst}`}>
            <legend className={styles.groupLegend}>اعتبار</legend>
            <label className={styles.option}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={Boolean(params.verifiedOnly)}
                onChange={() => setParams((p) => ({ ...p, verifiedOnly: p.verifiedOnly ? undefined : true, page: 1 }))}
              />
              <span>فقط متخصص‌های تأییدشده</span>
              {verifiedCount !== null ? <span className={styles.optionCount}>{toPersianDigits(verifiedCount)}</span> : null}
            </label>
          </fieldset>

          {result && result.facets.specialties.length > 0 ? (
            <fieldset className={styles.group}>
              <legend className={styles.groupLegend}>تخصص</legend>
              {result.facets.specialties.map((specialty) => (
                <label key={specialty.key} className={styles.option} data-specialty={specialty.key}>
                  <input
                    type="checkbox"
                    className={styles.checkbox}
                    checked={params.specialtyIds?.includes(specialty.key) ?? false}
                    onChange={() => toggleSpecialty(specialty.key)}
                  />
                  <span>{specialty.label ?? 'تخصص'}</span>
                  <span className={styles.optionCount}>{toPersianDigits(specialty.count)}</span>
                </label>
              ))}
            </fieldset>
          ) : null}

          <fieldset className={styles.group}>
            <legend className={styles.groupLegend}>محدوده قیمت</legend>
            <label className={styles.option}>
              <input
                type="radio"
                name="price-band"
                className={styles.checkbox}
                checked={band === null}
                onChange={() => setBand(null)}
              />
              <span>همه</span>
            </label>
            {Object.entries(PRICE_BANDS).map(([key, definition]) => {
              const count = result?.facets.priceRanges.find((b) => b.key === key)?.count ?? 0;
              return (
                <label key={key} className={`${styles.option} ${count === 0 ? styles.optionEmpty : ''}`} data-band={key}>
                  <input
                    type="radio"
                    name="price-band"
                    className={styles.checkbox}
                    checked={band === key}
                    onChange={() => setBand(key)}
                  />
                  <span>{definition.label}</span>
                  <span className={styles.optionCount}>{toPersianDigits(count)}</span>
                </label>
              );
            })}
          </fieldset>

          <button type="button" className={styles.sheetDone} onClick={() => setSheetOpen(false)}>
            نمایش نتایج
          </button>
        </aside>

        <div>
          <div className={styles.controlBar}>
            <button
              type="button"
              className={styles.filterToggle}
              onClick={() => setSheetOpen(true)}
              aria-expanded={sheetOpen}
              aria-controls="filter-panel"
            >
              <span className={styles.filterToggleGlyph} aria-hidden="true" />
              فیلترها
              {activeFilters.length > 0 ? (
                <span className={styles.filterToggleCount}>{toPersianDigits(activeFilters.length)}</span>
              ) : null}
            </button>

            <label className={styles.sortLabel} htmlFor="search-sort">
              ترتیب:
            </label>
            <select
              id="search-sort"
              className={styles.sortSelect}
              value={params.sort ?? 'relevance'}
              onChange={(event) => setParams((p) => ({ ...p, sort: event.target.value, page: 1 }))}
              aria-label="ترتیب نتایج"
            >
              {SORTS.map((sort) => (
                <option key={sort.key} value={sort.key}>
                  {sort.label}
                </option>
              ))}
            </select>
          </div>

          {activeFilters.length > 0 ? (
            <div className={styles.chipRow} data-testid="active-filters">
              {activeFilters.map((filter) => (
                <span key={filter.key} className={styles.chip} data-filter={filter.key}>
                  {filter.label}
                  <button
                    type="button"
                    className={`${styles.chipRemove} bc-tap`}
                    aria-label={`حذف فیلتر ${filter.label}`}
                    onClick={filter.clear}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}

          {saveError ? <Alert tone="error">{saveError}</Alert> : null}

          {result?.degraded && (
            // Told, not hidden: a degraded result set has no fuzzy matching and no
            // relevance ordering, and silently presenting it as normal would make
            // "search got worse" indistinguishable from "there is nothing here".
            // `info`, not `error`: nothing failed.
            <Alert tone="info">
              نتایج به‌صورت موقت محدود است؛ ممکن است برخی موارد نمایش داده نشود. لطفاً بعداً دوباره تلاش کنید.
            </Alert>
          )}

          {/*
            The status line reports exactly one of three distinct states, and
            never conflates them. It used to collapse "the request failed" and
            "the server answered, with nothing" into the same sentence, so a
            failed search told the user "نتیجه‌ای یافت نشد" -- and, being in
            this live region, announced it. That sends someone off rewording a
            perfectly good query to fix a problem that was never theirs.
          */}
          <p aria-live="polite" className={styles.count}>
            {loading
              ? 'در حال جست‌وجو…'
              : error
                ? ''
                : result
                  ? result.pagination.total > 0
                    ? `${toPersianDigits(result.pagination.total)} متخصص یافت شد`
                    : ''
                  : ''}
          </p>

          {/*
            A failed read gets a retry, not a bare message. `01_SEARCH.md`:
            "error: ErrorState with retry (today an Alert with no retry --
            must be corrected)."
          */}
          {error && !result ? <ErrorState message={error} onRetry={() => void run(params)} /> : null}

          {error && result && result.items.length > 0 ? (
            <p className={styles.staleNotice}>نتایج زیر مربوط به جست‌وجوی قبلی است و ممکن است به‌روز نباشد.</p>
          ) : null}

          {loading && !result ? (
            <div className={styles.cardList}>
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className={styles.skeletonCard} data-testid="result-skeleton">
                  <div className={styles.skeletonArt} />
                  <div className={styles.skeletonLines}>
                    <div className={styles.skeletonLine} />
                    <div className={`${styles.skeletonLine} ${styles.skeletonLineShort}`} />
                  </div>
                </div>
              ))}
            </div>
          ) : !error && result && result.items.length === 0 ? (
            <p className={styles.stateBlock}>
              جست‌وجوی شما نتیجه‌ای نداشت. می‌توانید فیلترها را بردارید یا عبارت دیگری امتحان کنید.
            </p>
          ) : (
            <div className={styles.cardList} data-testid="results">
              {(result?.items ?? []).map((item, index) => (
                <article key={item.id} className={styles.card} data-provider={item.id}>
                  {/* Placeholder artwork: `avatarUrl` and `portfolioCount` are
                      not in the public search result at this baseline. */}
                  <div
                    className={`${styles.cardArt} ${index % 2 === 1 ? styles.cardArtBronze : ''}`}
                    aria-hidden="true"
                  >
                    <span className={styles.cardArtLabel}>نمونه کار</span>
                  </div>

                  <div className={styles.cardBody}>
                    <div>
                      <div className={styles.nameRow}>
                        <h2 className={styles.cardName}>
                          <Link href={`/providers/${item.id}?from=search`}>{item.displayName}</Link>
                        </h2>
                        {item.isVerified ? (
                          <span className={styles.verified}>
                            <span className={styles.verifiedDot} aria-hidden="true" />
                            تأیید شده
                          </span>
                        ) : null}
                        {item.saved === null ? (
                          /* Anonymous: `null` is not "not saved". Sending
                             them to sign in is honest; rendering an unsaved
                             control would claim something about someone the
                             server cannot identify. */
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
                            disabled={savingIds.has(item.id)}
                            aria-label={
                              item.saved
                                ? `حذف ${item.displayName} از علاقه‌مندی‌ها`
                                : `افزودن ${item.displayName} به علاقه‌مندی‌ها`
                            }
                            onClick={() => void toggleSaved(item)}
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
                            {formatToman(item.priceFromToman)} <span className={styles.priceUnit}>تومان</span>
                          </div>
                        </>
                      )}
                    </div>
                    <Link href={`/providers/${item.id}?from=search`} className={styles.cardAction}>
                      دیدن زمان‌ها
                    </Link>
                  </div>
                </article>
              ))}
            </div>
          )}

          {result && result.pagination.totalPages > 1 ? (
            <nav aria-label="صفحه‌بندی" className={styles.pager}>
              <button
                type="button"
                className={styles.sortSelect}
                disabled={result.pagination.page <= 1}
                onClick={() => setParams((p) => ({ ...p, page: (p.page ?? 1) - 1 }))}
              >
                قبلی
              </button>
              <span className={styles.pageIndicator}>
                صفحه {toPersianDigits(result.pagination.page)} از {toPersianDigits(result.pagination.totalPages)}
              </span>
              <button
                type="button"
                className={styles.sortSelect}
                disabled={result.pagination.page >= result.pagination.totalPages}
                onClick={() => setParams((p) => ({ ...p, page: (p.page ?? 1) + 1 }))}
              >
                بعدی
              </button>
            </nav>
          ) : null}
        </div>
      </div>
    </section>
  );
}
