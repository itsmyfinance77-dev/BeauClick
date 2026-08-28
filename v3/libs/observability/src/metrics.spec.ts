import { DEFAULT_LATENCY_BUCKETS, METRICS, MetricsRegistry, registerPlatformMetrics } from './metrics';

/**
 * The Prometheus exposition format, and the cardinality ceiling.
 *
 * Two things are worth pinning here and one of them is easy to get silently
 * wrong: a histogram exported NON-cumulatively parses without complaint and
 * produces wrong quantiles, so every latency dashboard built on it lies. That
 * is asserted directly rather than left to a comment.
 */
describe('MetricsRegistry', () => {
  let registry: MetricsRegistry;

  beforeEach(() => {
    registry = new MetricsRegistry();
  });

  describe('counters', () => {
    it('renders HELP, TYPE, and one line per label combination', () => {
      registry.registerCounter('bc_things_total', 'Things.', ['kind']);
      registry.increment('bc_things_total', { kind: 'a' });
      registry.increment('bc_things_total', { kind: 'a' });
      registry.increment('bc_things_total', { kind: 'b' });

      const output = registry.render();
      expect(output).toContain('# HELP bc_things_total Things.');
      expect(output).toContain('# TYPE bc_things_total counter');
      expect(output).toContain('bc_things_total{kind="a"} 2');
      expect(output).toContain('bc_things_total{kind="b"} 1');
    });

    it('ignores an unregistered metric instead of throwing', () => {
      // A metrics call must never be the thing that fails a request. A typo in
      // a metric name is a missing graph, not a 500.
      expect(() => registry.increment('bc_never_registered', { a: 'b' })).not.toThrow();
    });

    it('orders labels deterministically, so the same series is one series', () => {
      registry.registerCounter('bc_x_total', 'X.', ['a', 'b']);
      registry.increment('bc_x_total', { b: '2', a: '1' });
      registry.increment('bc_x_total', { a: '1', b: '2' });
      expect(registry.render()).toContain('bc_x_total{a="1",b="2"} 2');
    });
  });

  describe('histograms', () => {
    it('exports CUMULATIVE buckets', () => {
      registry.registerHistogram('bc_seconds', 'Seconds.', [], [0.1, 1, 10]);
      registry.observe('bc_seconds', 0.05);
      registry.observe('bc_seconds', 0.5);
      registry.observe('bc_seconds', 5);

      const output = registry.render();
      // le=0.1 counts the 0.05 observation; le=1 counts 0.05 AND 0.5; le=10
      // counts all three. A non-cumulative export would read 1, 1, 1 and every
      // quantile computed from it would be wrong.
      expect(output).toContain('bc_seconds_bucket{le="0.1"} 1');
      expect(output).toContain('bc_seconds_bucket{le="1"} 2');
      expect(output).toContain('bc_seconds_bucket{le="10"} 3');
      expect(output).toContain('bc_seconds_bucket{le="+Inf"} 3');
      expect(output).toContain('bc_seconds_count 3');
      expect(output).toContain('bc_seconds_sum 5.55');
    });

    it('counts an observation above every bucket in +Inf only', () => {
      registry.registerHistogram('bc_seconds', 'Seconds.', [], [0.1]);
      registry.observe('bc_seconds', 99);
      const output = registry.render();
      expect(output).toContain('bc_seconds_bucket{le="0.1"} 0');
      expect(output).toContain('bc_seconds_bucket{le="+Inf"} 1');
    });

    it('sorts caller-supplied buckets, because an unsorted one breaks the cumulative property', () => {
      registry.registerHistogram('bc_seconds', 'Seconds.', [], [10, 0.1, 1]);
      registry.observe('bc_seconds', 0.5);
      const lines = registry.render().split('\n').filter((l) => l.includes('_bucket{'));
      expect(lines[0]).toContain('le="0.1"');
      expect(lines[1]).toContain('le="1"');
      expect(lines[2]).toContain('le="10"');
    });

    it('ships latency buckets in SECONDS, as the format requires', () => {
      expect(DEFAULT_LATENCY_BUCKETS[0]).toBeLessThan(1);
      expect(DEFAULT_LATENCY_BUCKETS[DEFAULT_LATENCY_BUCKETS.length - 1]).toBe(10);
    });
  });

  describe('gauges', () => {
    it('reads at scrape time rather than from a pushed value', () => {
      let depth = 3;
      registry.registerGauge('bc_depth', 'Depth.', () => depth);
      expect(registry.render()).toContain('bc_depth 3');
      depth = 7;
      expect(registry.render()).toContain('bc_depth 7');
    });

    it('drops one failing gauge rather than the whole scrape', () => {
      // Losing a series is a gap in one graph. Losing the scrape is a blind
      // spot across every metric at once, at the moment something is wrong.
      registry.registerGauge('bc_broken', 'Broken.', () => {
        throw new Error('the pool is gone');
      });
      registry.registerCounter('bc_fine_total', 'Fine.');
      registry.increment('bc_fine_total');

      const output = registry.render();
      expect(output).toContain('bc_fine_total 1');
      expect(output).not.toContain('bc_broken ');
    });

    it('drops a non-finite gauge, which would render as `NaN` and break the parser', () => {
      registry.registerGauge('bc_nan', 'NaN.', () => Number.NaN);
      expect(registry.render()).not.toContain('bc_nan ');
    });
  });

  describe('cardinality ceiling', () => {
    it('stops accepting NEW label combinations and reports how many it refused', () => {
      // The failure mode a metrics endpoint actually dies of. An unbounded map
      // keyed by a user id, an order id, or a raw path grows until the process
      // does not fit in memory.
      registry.registerCounter('bc_wide_total', 'Wide.', ['id']);
      for (let i = 0; i < 600; i += 1) registry.increment('bc_wide_total', { id: String(i) });

      const output = registry.render();
      const series = output.split('\n').filter((l) => l.startsWith('bc_wide_total{'));
      expect(series).toHaveLength(500);
      // Truncation is VISIBLE rather than silent -- otherwise a dashboard
      // built on a truncated metric looks complete.
      expect(output).toContain('beauclick_metrics_series_dropped_total 100');
    });

    it('keeps counting the combinations it already has after the ceiling is hit', () => {
      registry.registerCounter('bc_wide_total', 'Wide.', ['id']);
      for (let i = 0; i < 600; i += 1) registry.increment('bc_wide_total', { id: String(i) });
      registry.increment('bc_wide_total', { id: '0' });
      expect(registry.render()).toContain('bc_wide_total{id="0"} 2');
    });
  });

  describe('output safety', () => {
    it('escapes a label value that would otherwise corrupt every following line', () => {
      registry.registerCounter('bc_x_total', 'X.', ['v']);
      registry.increment('bc_x_total', { v: 'a"b\nc\\d' });
      const output = registry.render();
      expect(output).toContain('bc_x_total{v="a\\"b\\nc\\\\d"} 1');
      // One line per series, still.
      expect(output.split('\n').filter((l) => l.startsWith('bc_x_total{'))).toHaveLength(1);
    });

    it('ends with a newline, which some scrapers require', () => {
      registry.registerCounter('bc_x_total', 'X.');
      registry.increment('bc_x_total');
      expect(registry.render().endsWith('\n')).toBe(true);
    });
  });

  describe('registerPlatformMetrics', () => {
    it('registers the metrics the infrastructure plan asks for', () => {
      registerPlatformMetrics(registry);
      registry.increment(METRICS.httpRequests, { method: 'GET', route: '/v1/orders/:id', status: '2xx' });
      registry.observe(METRICS.httpDuration, 0.02, { method: 'GET', route: '/v1/orders/:id' });
      registry.increment(METRICS.paymentVerifications, { outcome: 'unresolved' });

      const output = registry.render();
      expect(output).toContain('beauclick_http_requests_total{method="GET",route="/v1/orders/:id",status="2xx"} 1');
      expect(output).toContain('beauclick_http_request_duration_seconds_count{method="GET",route="/v1/orders/:id"} 1');
      expect(output).toContain('beauclick_payment_verifications_total{outcome="unresolved"} 1');
    });

    it('is idempotent, so a second registration does not reset a counter', () => {
      registerPlatformMetrics(registry);
      registry.increment(METRICS.httpRequests, { method: 'GET', route: '/x', status: '2xx' });
      registerPlatformMetrics(registry);
      expect(registry.render()).toContain('beauclick_http_requests_total{method="GET",route="/x",status="2xx"} 1');
    });
  });
});
