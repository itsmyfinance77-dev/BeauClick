'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatToman, toPersianDigits } from '@beauclick/persian-utils';
import { useAuth } from '@/lib/auth-context';
import { Alert, Button, Card, LoadingState } from '@/components/ui';
import { autocomplete, searchProviders, type SearchParams, type SearchResponse } from '@/lib/phase3-api';

const SORTS = [
  { key: 'relevance', label: 'مرتبط‌ترین' },
  { key: 'ranking', label: 'برترین‌ها' },
  { key: 'price_asc', label: 'ارزان‌ترین' },
  { key: 'price_desc', label: 'گران‌ترین' },
] as const;

const BADGE_LABELS: Record<string, string> = {
  verified: 'تأییدشده',
  high_rating: 'امتیاز بالا',
  reliable: 'قابل اعتماد',
  recent_activity: 'فعال',
  complete_profile: 'پروفایل کامل',
};

const PRICE_BAND_LABELS: Record<string, string> = {
  under_500k: 'تا ۵۰۰ هزار تومان',
  '500k_1m': '۵۰۰ هزار تا ۱ میلیون',
  '1m_2m': '۱ تا ۲ میلیون',
  over_2m: 'بیش از ۲ میلیون',
};

export default function SearchPage() {
  const { api } = useAuth();
  const [query, setQuery] = useState('');
  const [params, setParams] = useState<SearchParams>({ sort: 'relevance', page: 1 });
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
      return;
    }
    const timer = setTimeout(() => {
      void autocomplete(api, query.trim())
        .then((res) => setSuggestions((res.data?.suggestions ?? []).map((s) => s.text)))
        .catch(() => setSuggestions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, api]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSuggestions([]);
    setParams((p) => ({ ...p, q: query, page: 1 }));
  };

  const toggleVerified = () => setParams((p) => ({ ...p, verifiedOnly: !p.verifiedOnly, page: 1 }));

  return (
    <section>
      <h1 style={{ fontSize: 24, marginBlockEnd: 4 }}>جست‌وجوی متخصص</h1>
      <p style={{ color: 'var(--bc-color-ink-faint)', marginBlockEnd: 20, fontSize: 14 }}>
        نام متخصص، خدمت یا شهر را بنویسید.
      </p>

      <form onSubmit={submit} role="search" style={{ marginBlockEnd: 20 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 240px', minWidth: 0, position: 'relative' }}>
            <label htmlFor="search-q" style={{ display: 'block', fontWeight: 600, fontSize: 14, marginBlockEnd: 6 }}>
              جست‌وجو
            </label>
            <input
              id="search-q"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="مثلاً میکاپ عروس"
              autoComplete="off"
              // The listbox relationship is what makes the suggestions
              // reachable by a screen reader rather than purely visual.
              role="combobox"
              aria-expanded={suggestions.length > 0}
              aria-controls="search-suggestions"
              aria-autocomplete="list"
              style={{
                width: '100%',
                font: 'inherit',
                padding: '12px 14px',
                minHeight: 44,
                borderRadius: 'var(--bc-radius-input)',
                border: '1px solid var(--bc-color-line)',
                background: 'var(--bc-color-surface)',
                color: 'var(--bc-color-ink)',
              }}
            />
            {suggestions.length > 0 && (
              <ul
                id="search-suggestions"
                role="listbox"
                aria-label="پیشنهادها"
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 4,
                  position: 'absolute',
                  insetInlineStart: 0,
                  insetInlineEnd: 0,
                  zIndex: 10,
                  background: 'var(--bc-color-surface)',
                  border: '1px solid var(--bc-color-line)',
                  borderRadius: 'var(--bc-radius-input)',
                }}
              >
                {suggestions.map((text) => (
                  <li key={text} role="option" aria-selected={false}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery(text);
                        setSuggestions([]);
                        setParams((p) => ({ ...p, q: text, page: 1 }));
                      }}
                      style={{
                        font: 'inherit',
                        width: '100%',
                        textAlign: 'start',
                        padding: '10px 12px',
                        minHeight: 44,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--bc-color-ink)',
                        cursor: 'pointer',
                        borderRadius: 'var(--bc-radius-input)',
                      }}
                    >
                      {text}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div style={{ alignSelf: 'flex-end', minWidth: 120 }}>
            <Button type="submit">جست‌وجو</Button>
          </div>
        </div>
      </form>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBlockEnd: 16 }}>
        <button
          type="button"
          onClick={toggleVerified}
          aria-pressed={Boolean(params.verifiedOnly)}
          style={chipStyle(Boolean(params.verifiedOnly))}
        >
          فقط تأییدشده
        </button>
        {SORTS.map((sort) => (
          <button
            key={sort.key}
            type="button"
            onClick={() => setParams((p) => ({ ...p, sort: sort.key, page: 1 }))}
            aria-pressed={params.sort === sort.key}
            style={chipStyle(params.sort === sort.key)}
          >
            {sort.label}
          </button>
        ))}
      </div>

      {result?.degraded && (
        // Told, not hidden: a degraded result set has no fuzzy matching and no
        // relevance ordering, and silently presenting it as normal would make
        // "search got worse" indistinguishable from "there is nothing here".
        <Alert tone="error">
          نتایج به‌صورت موقت محدود است؛ ممکن است برخی موارد نمایش داده نشود. لطفاً بعداً دوباره تلاش کنید.
        </Alert>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      {loading && !result ? (
        <LoadingState label="در حال جست‌وجو…" />
      ) : (
        <>
          <p aria-live="polite" style={{ fontSize: 14, color: 'var(--bc-color-ink-faint)', marginBlockEnd: 12 }}>
            {result && result.pagination.total > 0
              ? `${toPersianDigits(result.pagination.total)} نتیجه یافت شد`
              : 'نتیجه‌ای یافت نشد'}
          </p>

          {result && result.items.length === 0 && (
            <Card>
              <p style={{ margin: 0 }}>
                جست‌وجوی شما نتیجه‌ای نداشت. می‌توانید فیلترها را بردارید یا عبارت دیگری امتحان کنید.
              </p>
            </Card>
          )}

          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: 'var(--bc-spacing-card-gap)' }}>
            {(result?.items ?? []).map((item) => (
              <li key={item.id}>
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <h2 style={{ fontSize: 18, margin: 0 }}>
                        <Link
                          href={`/providers/${item.id}?from=search`}
                          style={{
                            color: 'var(--bc-color-ink)',
                            textDecoration: 'none',
                            // The primary way into a provider from a result
                            // list, so it gets a real touch target. Measured at
                            // 24px in a 375px viewport during live QA -- the
                            // same class of finding as Phase 2's 25px nav links,
                            // and below the 44px baseline this project set.
                            display: 'inline-flex',
                            alignItems: 'center',
                            minHeight: 44,
                          }}
                        >
                          {item.displayName}
                        </Link>
                      </h2>
                      {item.city && (
                        <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>
                          {item.city.name}
                        </p>
                      )}
                      {item.specialties.length > 0 && (
                        <p style={{ margin: '6px 0 0', fontSize: 13 }}>{item.specialties.join('، ')}</p>
                      )}
                    </div>
                    {item.priceFromToman !== null && (
                      <p style={{ margin: 0, fontWeight: 700, whiteSpace: 'nowrap' }}>
                        از {formatToman(item.priceFromToman)} تومان
                      </p>
                    )}
                  </div>

                  {item.badges.length > 0 && (
                    <ul style={{ listStyle: 'none', display: 'flex', gap: 6, flexWrap: 'wrap', padding: 0, margin: '10px 0 0' }}>
                      {item.badges.map((badge) => (
                        <li
                          key={badge}
                          style={{
                            fontSize: 12,
                            padding: '4px 10px',
                            borderRadius: 999,
                            background: 'var(--bc-color-surface-muted)',
                            color: 'var(--bc-color-ink-faint)',
                          }}
                        >
                          {BADGE_LABELS[badge] ?? badge}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </li>
            ))}
          </ul>

          {result && result.facets.priceRanges.length > 0 && (
            <section style={{ marginBlockStart: 24 }}>
              <h2 style={{ fontSize: 16 }}>محدوده قیمت</h2>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {result.facets.priceRanges.map((band) => (
                  <li key={band.key} style={{ fontSize: 13, color: 'var(--bc-color-ink-faint)' }}>
                    {PRICE_BAND_LABELS[band.key] ?? band.key}: {toPersianDigits(band.count)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {result && result.pagination.totalPages > 1 && (
            <nav aria-label="صفحه‌بندی" style={{ display: 'flex', gap: 8, marginBlockStart: 20, justifyContent: 'center' }}>
              <button
                type="button"
                disabled={result.pagination.page <= 1}
                onClick={() => setParams((p) => ({ ...p, page: (p.page ?? 1) - 1 }))}
                style={chipStyle(false)}
              >
                قبلی
              </button>
              <span style={{ alignSelf: 'center', fontSize: 14 }}>
                صفحه {toPersianDigits(result.pagination.page)} از {toPersianDigits(result.pagination.totalPages)}
              </span>
              <button
                type="button"
                disabled={result.pagination.page >= result.pagination.totalPages}
                onClick={() => setParams((p) => ({ ...p, page: (p.page ?? 1) + 1 }))}
                style={chipStyle(false)}
              >
                بعدی
              </button>
            </nav>
          )}
        </>
      )}
    </section>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    font: 'inherit',
    fontSize: 14,
    padding: '10px 16px',
    minHeight: 44,
    borderRadius: 999,
    border: `1px solid ${active ? 'var(--bc-color-primary)' : 'var(--bc-color-line)'}`,
    background: active ? 'var(--bc-color-primary)' : 'transparent',
    color: active ? 'var(--bc-color-surface)' : 'var(--bc-color-ink)',
    cursor: 'pointer',
  };
}
