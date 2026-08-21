/**
 * The OpenSearch index definition for provider search.
 *
 * Every analyzer decision below was validated against a real OpenSearch
 * 2.19.1 instance with `_analyze`, not assumed from documentation. The
 * findings that shaped it:
 *
 *  1. **Lucene's `persian_normalization` does NOT strip ZWNJ.** Probed
 *     directly: `می‌کاپ` (with U+200C) analyses to a single token that still
 *     contains the ZWNJ, while `میکاپ` analyses to one without it. The two
 *     spellings of the same word therefore DO NOT MATCH under the built-in
 *     Persian chain alone. ZWNJ placement in real Persian text is genuinely
 *     inconsistent, so this is not an edge case -- it is the single most
 *     likely way a correct query misses a correct document. The mapping
 *     char_filter is what closes it, and it is load-bearing rather than
 *     belt-and-braces.
 *
 *  2. **`arabic_normalization` already folds Arabic kaf/yeh and teh-marbuta.**
 *     Probed: `زيبايي` (Arabic yeh) and `زیبایی` (Persian yeh) produce
 *     identical tokens with or without the char_filter. The explicit mappings
 *     are kept anyway because they must ALSO apply to the `keyword`-adjacent
 *     autocomplete path and to fields where the token filter chain differs --
 *     relying on one filter's internals to cover another field's needs is
 *     exactly the kind of coupling that breaks silently on an upgrade.
 *
 *  3. **Bidi control characters survive the built-in chain.** U+200E/U+200F
 *     appear in real copy-pasted Persian text and would otherwise become part
 *     of a token. Stripped explicitly.
 *
 * `decimal_digit` handles BOTH Persian (۰-۹) and Arabic-Indic (٠-٩) digits --
 * verified: `٤٥٦` analyses to `456`. This is the index-time half of the same
 * normalization `@beauclick/persian-utils` performs for display, and carrying
 * it forward was a named requirement of ADR-005.
 */

/** Bumped whenever the mapping below changes in a way that requires a reindex. */
export const PROVIDER_INDEX_MAPPING_VERSION = 1;

/** The alias every query and write goes through. The physical index behind it is swappable. */
export const PROVIDER_INDEX_ALIAS = 'beauclick-providers';

export function physicalIndexName(version: number): string {
  return `${PROVIDER_INDEX_ALIAS}-v${version}`;
}

const PERSIAN_CHAR_MAPPINGS = [
  // Arabic letter forms -> their canonical Persian equivalent.
  'ي=>ی', // Arabic yeh -> Farsi yeh
  'ى=>ی', // Alef maksura -> Farsi yeh
  'ك=>ک', // Arabic kaf -> keheh
  'ة=>ه', // Teh marbuta -> heh
  'أ=>ا', // Alef with hamza above -> alef
  'إ=>ا', // Alef with hamza below -> alef
  'آ=>ا', // Alef with madda -> alef
  'ؤ=>و', // Waw with hamza -> waw
  // Zero-width and bidi controls -> nothing. See finding (1) and (3) above.
  '‌=>',
  '‍=>',
  '‎=>',
  '‏=>',
];

export const PROVIDER_INDEX_SETTINGS = {
  index: {
    // One shard: the entire corpus is a few hundred documents. More shards
    // would spread a tiny dataset across segments and make relevance scoring
    // WORSE (per-shard IDF), for no throughput gain.
    number_of_shards: 1,
    // Zero replicas on a single-node dev cluster -- a replica that can never
    // be allocated leaves the cluster permanently yellow and makes a genuine
    // health problem indistinguishable from the normal state.
    number_of_replicas: 0,
    max_ngram_diff: 20,
  },
  analysis: {
    char_filter: {
      bc_persian_chars: { type: 'mapping', mappings: PERSIAN_CHAR_MAPPINGS },
    },
    filter: {
      bc_persian_stop: { type: 'stop', stopwords: '_persian_' },
      // min_gram 2: a single character prefix matches almost every document,
      // so it costs a full scan to return nothing useful.
      bc_edge_ngram: { type: 'edge_ngram', min_gram: 2, max_gram: 20 },
    },
    analyzer: {
      /** Index and query analyzer for full-text fields. */
      bc_persian: {
        type: 'custom',
        char_filter: ['bc_persian_chars'],
        tokenizer: 'standard',
        filter: ['lowercase', 'decimal_digit', 'arabic_normalization', 'persian_normalization', 'bc_persian_stop'],
      },
      /**
       * INDEX-time analyzer for autocomplete. Deliberately paired with
       * `bc_persian_autocomplete_search` at query time: applying edge_ngram to
       * the QUERY too would make "می" match a document containing "م", which
       * is the classic autocomplete relevance bug.
       */
      bc_persian_autocomplete: {
        type: 'custom',
        char_filter: ['bc_persian_chars'],
        tokenizer: 'standard',
        filter: ['lowercase', 'decimal_digit', 'arabic_normalization', 'persian_normalization', 'bc_edge_ngram'],
      },
      bc_persian_autocomplete_search: {
        type: 'custom',
        char_filter: ['bc_persian_chars'],
        tokenizer: 'standard',
        filter: ['lowercase', 'decimal_digit', 'arabic_normalization', 'persian_normalization'],
      },
      /**
       * Normalization without stopword removal, for fields where a stopword
       * can be the whole meaningful content (a short service name).
       */
      bc_persian_exact: {
        type: 'custom',
        char_filter: ['bc_persian_chars'],
        tokenizer: 'standard',
        filter: ['lowercase', 'decimal_digit', 'arabic_normalization', 'persian_normalization'],
      },
    },
  },
} as const;

export const PROVIDER_INDEX_MAPPINGS = {
  // A field nobody declared is a field nobody designed. Strict mapping turns
  // an accidental extra key into a loud indexing error instead of a silently
  // created field that consumes memory and can never be searched usefully.
  dynamic: 'strict',
  properties: {
    professionalId: { type: 'keyword' },
    revision: { type: 'long' },
    displayName: {
      type: 'text',
      analyzer: 'bc_persian',
      fields: {
        // For exact-phrase boosting and for sorting by name.
        keyword: { type: 'keyword', ignore_above: 256 },
        autocomplete: {
          type: 'text',
          analyzer: 'bc_persian_autocomplete',
          search_analyzer: 'bc_persian_autocomplete_search',
        },
      },
    },
    bio: { type: 'text', analyzer: 'bc_persian' },
    cityId: { type: 'keyword' },
    cityName: {
      type: 'text',
      analyzer: 'bc_persian',
      fields: { keyword: { type: 'keyword', ignore_above: 120 } },
    },
    specialtyIds: { type: 'keyword' },
    specialtyNames: {
      type: 'text',
      analyzer: 'bc_persian',
      fields: {
        keyword: { type: 'keyword', ignore_above: 120 },
        autocomplete: {
          type: 'text',
          analyzer: 'bc_persian_autocomplete',
          search_analyzer: 'bc_persian_autocomplete_search',
        },
      },
    },
    verificationStatus: { type: 'keyword' },
    isVerified: { type: 'boolean' },
    // `nested` rather than `object`: a flat object would let a query for
    // "a service named X costing under Y" match a provider who has a service
    // named X and a DIFFERENT service under Y. Nested keeps the fields of one
    // service bound to each other.
    services: {
      type: 'nested',
      properties: {
        serviceId: { type: 'keyword' },
        name: {
          type: 'text',
          analyzer: 'bc_persian_exact',
          fields: {
            autocomplete: {
              type: 'text',
              analyzer: 'bc_persian_autocomplete',
              search_analyzer: 'bc_persian_autocomplete_search',
            },
          },
        },
        priceToman: { type: 'long' },
        durationMinutes: { type: 'integer' },
      },
    },
    // Denormalized copy of every service name, so the top-level multi_match
    // can search service text without a nested query -- the nested mapping
    // above stays for the price+name correlation case only.
    serviceNames: { type: 'text', analyzer: 'bc_persian_exact' },
    minPriceToman: { type: 'long' },
    maxPriceToman: { type: 'long' },
    ratingAvg: { type: 'float' },
    reviewCount: { type: 'integer' },
    completedBookings: { type: 'integer' },
    rankingScore: { type: 'float' },
    rankingSignalKeys: { type: 'keyword' },
    indexedAt: { type: 'date' },
  },
} as const;
