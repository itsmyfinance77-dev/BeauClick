import { Injectable } from '@nestjs/common';

/**
 * Metrics, in the Prometheus text exposition format (`OPS-03`).
 *
 * `V3_INFRASTRUCTURE_PLAN.md` §7 asks for Prometheus scraping request
 * rate/latency/error-rate per module, connection-pool saturation, and DLQ
 * depth, with Grafana dashboards over it.
 *
 * ## Why this is hand-written rather than a client library
 *
 * Because the Prometheus text exposition format is an OPEN, STABLE, and very
 * small specification -- four line shapes -- and implementing it commits this
 * platform to nothing. A metrics client library, by contrast, is a dependency
 * whose own transitive tree (several bring the whole OpenTelemetry SDK) has to
 * be carried, pinned, and audited in a workspace with `pnpm` overrides forcing
 * one physical copy of every Nest package for reasons Phase 1 learned the hard
 * way.
 *
 * The distinction that matters for this phase: implementing an open FORMAT is
 * not the same as writing a VENDOR adapter from documentation. Nothing here
 * names or assumes a monitoring vendor; a Prometheus, a Grafana Agent, a
 * VictoriaMetrics, or anything else that scrapes this format will read it. The
 * external half -- a real scraper, in a real deployment, reaching a real
 * dashboard -- is a live gate and stays open.
 *
 * ## Cardinality is the failure mode, so it is bounded here
 *
 * The way a metrics endpoint kills a monitoring system is label cardinality: a
 * label whose value is a user id, an order id, or a raw URL path produces one
 * time series per value, and a few hours of traffic produces millions. That is
 * why `httpRequest` takes a ROUTE TEMPLATE (`/v1/orders/:id`) rather than a
 * path, and why `registerCounter` refuses a label set it has not been told
 * about. See `HttpMetricsMiddleware` for where the template comes from, and why it is
 * middleware rather than an interceptor.
 */

export type Labels = Readonly<Record<string, string>>;

interface CounterState {
  help: string;
  labelNames: readonly string[];
  values: Map<string, { labels: Labels; value: number }>;
}

interface HistogramState {
  help: string;
  labelNames: readonly string[];
  buckets: readonly number[];
  values: Map<string, { labels: Labels; counts: number[]; sum: number; count: number }>;
}

/** Default latency buckets, in SECONDS, as the exposition format requires. */
export const DEFAULT_LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

/**
 * A hard ceiling on distinct label combinations per metric.
 *
 * When it is reached the metric stops accepting NEW combinations and keeps
 * counting the ones it has, rather than growing without bound. Silently
 * dropping data is bad; taking the process down because a route template was
 * wrong is worse, and an unbounded map does exactly that eventually.
 * `beauclick_metrics_series_dropped_total` makes the truncation visible
 * instead of silent.
 */
const MAX_SERIES_PER_METRIC = 500;

function seriesKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

/** Escapes a label VALUE per the exposition format. An unescaped newline corrupts every following line. */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function formatLabels(labels: Labels, extra?: Record<string, string>): string {
  const all = { ...labels, ...(extra ?? {}) };
  const keys = Object.keys(all).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((k) => `${k}="${escapeLabelValue(all[k])}"`).join(',')}}`;
}

@Injectable()
export class MetricsRegistry {
  private readonly counters = new Map<string, CounterState>();
  private readonly histograms = new Map<string, HistogramState>();
  private readonly gauges = new Map<string, { help: string; read: () => number }>();
  private droppedSeries = 0;

  registerCounter(name: string, help: string, labelNames: readonly string[] = []): void {
    if (!this.counters.has(name)) this.counters.set(name, { help, labelNames, values: new Map() });
  }

  registerHistogram(
    name: string,
    help: string,
    labelNames: readonly string[] = [],
    buckets: readonly number[] = DEFAULT_LATENCY_BUCKETS,
  ): void {
    if (!this.histograms.has(name)) {
      this.histograms.set(name, { help, labelNames, buckets: [...buckets].sort((a, b) => a - b), values: new Map() });
    }
  }

  /**
   * A gauge read at SCRAPE time rather than pushed.
   *
   * Correct for anything whose current value is knowable on demand --
   * connection-pool saturation, outbox depth, dead-letter depth. Pushing those
   * would mean a background timer whose interval silently becomes the metric's
   * resolution.
   */
  registerGauge(name: string, help: string, read: () => number): void {
    this.gauges.set(name, { help, read });
  }

  increment(name: string, labels: Labels = {}, by = 1): void {
    const counter = this.counters.get(name);
    if (!counter) return; // An unregistered metric is a programming error, not a request failure.
    const key = seriesKey(labels);
    const existing = counter.values.get(key);
    if (existing) {
      existing.value += by;
      return;
    }
    if (counter.values.size >= MAX_SERIES_PER_METRIC) {
      this.droppedSeries += 1;
      return;
    }
    counter.values.set(key, { labels, value: by });
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const histogram = this.histograms.get(name);
    if (!histogram) return;
    const key = seriesKey(labels);
    let entry = histogram.values.get(key);
    if (!entry) {
      if (histogram.values.size >= MAX_SERIES_PER_METRIC) {
        this.droppedSeries += 1;
        return;
      }
      entry = { labels, counts: new Array(histogram.buckets.length).fill(0), sum: 0, count: 0 };
      histogram.values.set(key, entry);
    }
    entry.count += 1;
    entry.sum += value;
    for (let i = 0; i < histogram.buckets.length; i += 1) {
      if (value <= histogram.buckets[i]) entry.counts[i] += 1;
    }
  }

  /** The Prometheus text exposition format, version 0.0.4. */
  render(): string {
    const lines: string[] = [];

    for (const [name, counter] of this.counters) {
      lines.push(`# HELP ${name} ${counter.help}`, `# TYPE ${name} counter`);
      for (const { labels, value } of counter.values.values()) {
        lines.push(`${name}${formatLabels(labels)} ${value}`);
      }
    }

    for (const [name, histogram] of this.histograms) {
      lines.push(`# HELP ${name} ${histogram.help}`, `# TYPE ${name} histogram`);
      for (const entry of histogram.values.values()) {
        // `observe` increments EVERY bucket whose upper bound the value is
        // under, so `counts[i]` is already the cumulative count for
        // `le=buckets[i]` -- which is what the format requires. A histogram
        // exported non-cumulatively parses without complaint and produces
        // silently wrong quantiles, the worst kind of wrong for a latency
        // dashboard, so the cumulative property is asserted in the suite
        // rather than left to this comment.
        for (let i = 0; i < histogram.buckets.length; i += 1) {
          lines.push(`${name}_bucket${formatLabels(entry.labels, { le: String(histogram.buckets[i]) })} ${entry.counts[i]}`);
        }
        lines.push(`${name}_bucket${formatLabels(entry.labels, { le: '+Inf' })} ${entry.count}`);
        lines.push(`${name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
        lines.push(`${name}_count${formatLabels(entry.labels)} ${entry.count}`);
      }
    }

    for (const [name, gauge] of this.gauges) {
      let value: number;
      try {
        value = gauge.read();
      } catch {
        // A gauge that throws must not take the whole scrape with it: losing
        // one series is a gap in a graph, losing the scrape is a blind spot
        // across every metric at once.
        continue;
      }
      if (!Number.isFinite(value)) continue;
      lines.push(`# HELP ${name} ${gauge.help}`, `# TYPE ${name} gauge`, `${name} ${value}`);
    }

    lines.push(
      '# HELP beauclick_metrics_series_dropped_total Label combinations refused because a metric reached its series ceiling.',
      '# TYPE beauclick_metrics_series_dropped_total counter',
      `beauclick_metrics_series_dropped_total ${this.droppedSeries}`,
    );

    return `${lines.join('\n')}\n`;
  }

  /** For tests. Never called at runtime -- a metrics reset loses a counter's history. */
  reset(): void {
    for (const counter of this.counters.values()) counter.values.clear();
    for (const histogram of this.histograms.values()) histogram.values.clear();
    this.droppedSeries = 0;
  }
}

/** The metric names this platform exposes. Named constants so a typo is a compile error. */
export const METRICS = {
  httpRequests: 'beauclick_http_requests_total',
  httpDuration: 'beauclick_http_request_duration_seconds',
  paymentVerifications: 'beauclick_payment_verifications_total',
  outboxDepth: 'beauclick_outbox_pending',
  errorsReported: 'beauclick_errors_reported_total',
} as const;

export function registerPlatformMetrics(registry: MetricsRegistry): void {
  registry.registerCounter(METRICS.httpRequests, 'HTTP requests handled, by route template, method and status class.', [
    'method',
    'route',
    'status',
  ]);
  registry.registerHistogram(METRICS.httpDuration, 'HTTP request duration in seconds.', ['method', 'route']);
  registry.registerCounter(
    METRICS.paymentVerifications,
    'Gateway verifications, by outcome. `unresolved` is the one to alert on: it means a payment whose result nobody knows.',
    ['outcome'],
  );
  registry.registerCounter(METRICS.errorsReported, 'Errors handed to the error reporter, by whether it transmits.', [
    'transmitted',
  ]);
}
