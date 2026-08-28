import { StructuredLogger, buildLogRecord, logFormatFromEnv } from './structured-logger';

/**
 * Structured logging (`OPS-03`).
 *
 * The JSON path only runs in production by default, which makes it a format
 * first exercised in production unless something exercises it here. This is
 * that something.
 */
describe('logFormatFromEnv', () => {
  it('chooses JSON in production and human output everywhere else', () => {
    expect(logFormatFromEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('json');
    expect(logFormatFromEnv({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe('pretty');
    expect(logFormatFromEnv({} as NodeJS.ProcessEnv)).toBe('pretty');
  });

  it('can be forced either way, so the production format is runnable locally', () => {
    expect(logFormatFromEnv({ NODE_ENV: 'development', LOG_FORMAT: 'json' } as NodeJS.ProcessEnv)).toBe('json');
    expect(logFormatFromEnv({ NODE_ENV: 'production', LOG_FORMAT: 'pretty' } as NodeJS.ProcessEnv)).toBe('pretty');
  });
});

describe('buildLogRecord', () => {
  const at = '2026-08-29T10:00:00.000Z';

  it('keeps `message` a string even when the caller passed an object', () => {
    // An aggregator that indexes `message` as a string DROPS a line where it
    // is an object -- losing the line, not just the field.
    const record = buildLogRecord('log', { orderId: 'o1' }, 'Ctx', undefined, at, null);
    expect(typeof record.message).toBe('string');
    expect(record.message).toContain('o1');
  });

  it('attaches the correlation id when there is one, and omits it when there is not', () => {
    expect(buildLogRecord('log', 'hello', null, undefined, at, 'c-1').correlation).toBe('c-1');
    expect(buildLogRecord('log', 'hello', null, undefined, at, null)).not.toHaveProperty('correlation');
  });

  it('redacts the message', () => {
    const record = buildLogRecord('error', 'connect failed postgres://app:hunter2@db/x', null, undefined, at, null);
    expect(record.message).not.toContain('hunter2');
  });

  it('redacts the detail', () => {
    const record = buildLogRecord('log', 'sent', null, { phone: '+989123456789', otp: '123456' }, at, null);
    expect(JSON.stringify(record.detail)).not.toContain('9123456789');
    expect(JSON.stringify(record.detail)).not.toContain('123456');
  });

  it('omits `detail` entirely rather than emitting undefined', () => {
    expect(buildLogRecord('log', 'x', null, undefined, at, null)).not.toHaveProperty('detail');
  });
});

describe('StructuredLogger', () => {
  function capture(format: 'json' | 'pretty') {
    const lines: string[] = [];
    return { logger: new StructuredLogger(format, (line) => lines.push(line)), lines };
  }

  it('emits one parseable JSON object per line', () => {
    const { logger, lines } = capture('json');
    logger.log('booted', 'Bootstrap');
    logger.error('failed', 'Bootstrap');

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).not.toContain('\n');
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(JSON.parse(lines[0])).toEqual(
      expect.objectContaining({ level: 'log', context: 'Bootstrap', message: 'booted' }),
    );
  });

  it('reads Nest\'s trailing string as the CONTEXT, not as payload', () => {
    // Nest's own convention. Getting it wrong puts the class name in the
    // payload and the payload nowhere.
    const { logger, lines } = capture('json');
    logger.log('order paid', { orderId: 'o1' }, 'CheckoutService');
    const record = JSON.parse(lines[0]);
    expect(record.context).toBe('CheckoutService');
    expect(record.detail).toEqual({ orderId: 'o1' });
  });

  it('treats a trailing non-string as detail, with no context', () => {
    const { logger, lines } = capture('json');
    logger.warn('slow', { ms: 1200 });
    const record = JSON.parse(lines[0]);
    expect(record.context).toBeNull();
    expect(record.detail).toEqual({ ms: 1200 });
  });

  it('keeps a stack trace on ONE line, so it is one log event', () => {
    // A multi-line stack in a line-delimited stream is N events, N-1 of them
    // unparseable, and the aggregator drops them.
    const { logger, lines } = capture('json');
    logger.error(new Error('boom'), 'Ctx');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).message).toContain('boom');
  });

  it('never emits a secret, whichever format is active', () => {
    for (const format of ['json', 'pretty'] as const) {
      const { logger, lines } = capture(format);
      logger.error('connect failed postgres://app:hunter2@db/x', { authorization: 'Bearer abc123def456' }, 'Ctx');
      const output = lines.join('\n');
      expect(output).not.toContain('hunter2');
      expect(output).not.toContain('abc123def456');
    }
  });

  it('writes a readable line in pretty mode', () => {
    const { logger, lines } = capture('pretty');
    logger.log('booted', 'Bootstrap');
    expect(lines[0]).toContain('LOG');
    expect(lines[0]).toContain('[Bootstrap]');
    expect(lines[0]).toContain('booted');
  });
});
