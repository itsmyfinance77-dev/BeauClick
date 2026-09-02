import { MetricsRegistry } from '@beauclick/observability';

/**
 * The AI domain's metrics — what an operator gets instead of content.
 *
 * `V32-DEC-009` gives operators aggregate health, counts, and cost, and NOTHING
 * else: there is no content-reading route, no impersonation, and no moderation
 * queue. This file is therefore the entire operator-facing surface for the AI
 * domain, and it is worth reading as a statement of what that decision costs
 * and what it still permits.
 *
 * It permits a great deal. Volume, refusal mix, provider latency, provider
 * failure rate, and — the one that matters most operationally — the rate at
 * which a provider's named identifiers fail re-verification. A model that starts
 * hallucinating shows up here as a rising `dropped` count long before anybody
 * files a support ticket, and none of it requires reading a sentence anybody
 * typed.
 *
 * ## Cardinality, and why every label here is an enum
 *
 * `MetricsRegistry` caps series per metric and drops the overflow, so an
 * unbounded label does not take the process down — it silently truncates the
 * metric instead, which is worse in its own way. Every label below is drawn
 * from a closed set: a provider state (3 values), a refusal reason (4 values
 * reachable here), a failure kind (2). No user id, no conversation id, no
 * provider key, and above all no text.
 *
 * A `provider_key` label was considered and rejected: a key is a configuration
 * value that could one day hold a vendor's name, and `/metrics` is scraped into
 * dashboards that get screenshotted. `provider_state` answers the operational
 * question — did a real model answer, or the local assistant — without naming
 * anything.
 */
export const AI_METRICS = {
  conversations: 'beauclick_ai_conversations_total',
  messages: 'beauclick_ai_messages_total',
  refusals: 'beauclick_ai_refusals_total',
  providerFailures: 'beauclick_ai_provider_failures_total',
  recommendationClicks: 'beauclick_ai_recommendation_clicks_total',
  completionDuration: 'beauclick_ai_completion_duration_seconds',
} as const;

export function registerAiMetrics(registry: MetricsRegistry): void {
  registry.registerCounter(AI_METRICS.conversations, 'Assistant conversations started.');

  registry.registerCounter(
    AI_METRICS.messages,
    'Accepted customer messages that received an assistant reply, by what kind of thing answered. ' +
      '`simulated` means the deterministic local assistant served -- not a language model.',
    ['provider_state'],
  );

  registry.registerCounter(
    AI_METRICS.refusals,
    'Requests refused before or during acceptance, by reason. ' +
      '`injection` and `private_data_request` are separated HERE and nowhere a caller can see, so a rise is visible ' +
      'to an operator while a prober learns only that the request was refused.',
    ['reason'],
  );

  registry.registerCounter(
    AI_METRICS.providerFailures,
    'Provider calls that produced no usable answer. `invalid_output` is the one to watch: it means a provider is ' +
      'returning something that does not satisfy the response schema, which no retry will fix.',
    ['kind'],
  );

  registry.registerCounter(AI_METRICS.recommendationClicks, 'Validated recommendations a customer followed.');

  registry.registerHistogram(
    AI_METRICS.completionDuration,
    'Provider completion latency in seconds, by what kind of thing answered.',
    ['provider_state'],
    // Deliberately NOT the default HTTP buckets. The deterministic provider
    // answers in single-digit milliseconds and a real one will not; buckets that
    // put both in the same bin would make the honest comparison this platform
    // needs -- did latency change when we enabled a real provider -- unreadable.
    [0.005, 0.02, 0.1, 0.5, 1, 2, 5, 10, 20, 30],
  );
}
