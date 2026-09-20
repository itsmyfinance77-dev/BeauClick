import { Suspense } from 'react';
import { SearchResults } from './search-results';
import styles from './search.module.css';

/**
 * `/search` — a Suspense boundary around the results.
 *
 * ## Why this file is a wrapper and not the screen
 *
 * `SearchResults` reads `useSearchParams()`, to pick up the `?q=` the home
 * page's hero field and specialty shortcuts navigate with. In the App Router
 * that opts a component out of static prerendering, and Next refuses to build
 * a route that does so without a boundary:
 *
 *   useSearchParams() should be wrapped in a suspense boundary at page
 *   "/search"  -- and `next build` exits non-zero.
 *
 * Nothing else caught it: not the type checker, not the linter, not 405
 * tests. It is a production-build error, and only `nx build web` reports it.
 *
 * The boundary lives here rather than inside the screen so the screen stays
 * one component with one set of state, and the fallback is the same skeleton
 * it shows while its first search is in flight, so nothing jumps when the
 * boundary resolves.
 */
export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className={styles.cardList} aria-busy="true">
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
      }
    >
      <SearchResults />
    </Suspense>
  );
}
