import { acceptInboundCorrelationId, currentCorrelationId, newCorrelationId, runWithCorrelation } from './correlation';

describe('correlation context', () => {
  it('has no value outside any run() call', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('is visible inside the run() it was set for', () => {
    const id = newCorrelationId();
    runWithCorrelation(id, () => {
      expect(currentCorrelationId()).toBe(id);
    });
  });

  it('is visible across an awaited async gap inside run()', async () => {
    const id = newCorrelationId();
    await runWithCorrelation(id, async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(currentCorrelationId()).toBe(id);
    });
  });

  it('restores the outer value when a nested run() ends', () => {
    const outer = newCorrelationId();
    const inner = newCorrelationId();
    runWithCorrelation(outer, () => {
      runWithCorrelation(inner, () => {
        expect(currentCorrelationId()).toBe(inner);
      });
      expect(currentCorrelationId()).toBe(outer);
    });
  });

  it('does not leak between two concurrent async call stacks', async () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    const seenByA: (string | undefined)[] = [];
    const seenByB: (string | undefined)[] = [];

    // Interleaved on purpose: AsyncLocalStorage's whole job is keeping these
    // apart even though their awaits land on the same microtask queue.
    await Promise.all([
      runWithCorrelation(a, async () => {
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
          seenByA.push(currentCorrelationId());
        }
      }),
      runWithCorrelation(b, async () => {
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
          seenByB.push(currentCorrelationId());
        }
      }),
    ]);

    expect(seenByA.every((v) => v === a)).toBe(true);
    expect(seenByB.every((v) => v === b)).toBe(true);
  });
});

describe('acceptInboundCorrelationId', () => {
  it('accepts a well-formed UUID as-is, lowercased', () => {
    const upper = '01912D9E-6B3F-7A21-9C4E-0F1A2B3C4D5E';
    expect(acceptInboundCorrelationId(upper)).toBe(upper.toLowerCase());
  });

  it('mints a fresh id when nothing was supplied', () => {
    expect(acceptInboundCorrelationId(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('mints a fresh id for a non-string value (a repeated header arrives as an array)', () => {
    expect(acceptInboundCorrelationId(['a', 'b'])).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('REJECTS a value containing CR or LF rather than storing it', () => {
    // The id reaches nine outbox tables and every log line. A newline there is
    // the classic log-injection payload -- one write could look like several.
    // Node's http client independently refuses to even SEND a header value
    // containing one, but this is the layer that would catch it from any
    // OTHER transport (a raw socket, a non-Node client) that does not.
    const injected = 'not-a-uuid\nFAKE-LINE forged=true';
    const result = acceptInboundCorrelationId(injected);
    expect(result).not.toBe(injected);
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects a syntactically-plausible but non-UUID string', () => {
    const result = acceptInboundCorrelationId('not-a-uuid; injected=true');
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('rejects an oversized value rather than storing an arbitrary-length string', () => {
    const huge = 'a'.repeat(5000);
    const result = acceptInboundCorrelationId(huge);
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
