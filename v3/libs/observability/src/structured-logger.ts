import { LoggerService, LogLevel } from '@nestjs/common';
import { currentCorrelationId } from '@beauclick/events';

import { redact, redactText } from './redact';

/**
 * One JSON object per line, correlation-tagged, redacted (`OPS-03`).
 *
 * `V3_INFRASTRUCTURE_PLAN.md` §8 asks for structured JSON logs from every
 * process, correlation-ID-tagged, so a single request or event chain can be
 * traced across module and service boundaries -- "a real capability V2 never
 * had (no centralized logging existed at all)".
 *
 * Nest's default logger writes a coloured, human-shaped line with a timestamp
 * formatted in the process locale. That is genuinely nicer to read on a
 * terminal, and it is unusable as a log STREAM: the fields are positional,
 * the message may span lines (a stack trace does), and the correlation id --
 * which `AuditLogger` already attaches to audit records -- is only present on
 * the lines somebody remembered to put it on.
 *
 * ## Why the development format is kept
 *
 * A developer running the API locally is reading the terminal, not querying an
 * aggregator, and a wall of JSON there is a real cost with no benefit. The
 * format is therefore chosen by environment: JSON in production, Nest's own
 * output everywhere else. That is a genuine risk -- a format that only runs in
 * production is a format that is first exercised in production -- so the JSON
 * path is unit-tested directly and can be forced on with `LOG_FORMAT=json`.
 *
 * ## What it never emits
 *
 * Everything passes through `redact` first. See that file for why: a log
 * aggregator is a second copy of whatever you put in it, retained for months,
 * readable by more people than can read the database, and outside every access
 * control this platform enforces.
 */
export type LogFormat = 'json' | 'pretty';

export interface StructuredLogRecord {
  timestamp: string;
  level: string;
  /** Nest's "context" -- the class or subsystem that logged. */
  context: string | null;
  message: string;
  /** Present whenever the log call happened inside a request or an event handler. */
  correlation?: string;
  /** Anything else the caller passed, redacted. */
  detail?: unknown;
}

export function logFormatFromEnv(env: NodeJS.ProcessEnv): LogFormat {
  const explicit = env.LOG_FORMAT?.trim().toLowerCase();
  if (explicit === 'json' || explicit === 'pretty') return explicit;
  return env.NODE_ENV === 'production' ? 'json' : 'pretty';
}

/**
 * Builds the record. Pure, and exported, because this is the part worth
 * testing: the writing is one `console.log`.
 */
export function buildLogRecord(
  level: LogLevel,
  message: unknown,
  context: string | null,
  detail: unknown,
  timestamp: string,
  correlation: string | null,
): StructuredLogRecord {
  const record: StructuredLogRecord = {
    timestamp,
    level,
    context,
    // `message` is frequently an Error, or an object a caller passed as the
    // first argument. Both are flattened to a string here and the structured
    // form is kept in `detail`, so the field's TYPE is stable -- an aggregator
    // that indexes `message` as a string chokes on a line where it is an
    // object, and drops the line rather than the field.
    message: typeof message === 'string' ? redactText(message) : JSON.stringify(redact(message)),
  };
  if (correlation) record.correlation = correlation;
  if (detail !== undefined) record.detail = redact(detail);
  return record;
}

export class StructuredLogger implements LoggerService {
  constructor(
    private readonly format: LogFormat,
    /** Injected so the suite can capture without patching the global console. */
    private readonly sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('log', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('verbose', message, rest);
  }

  private write(level: LogLevel, message: unknown, rest: unknown[]): void {
    // Nest's convention: the LAST trailing string argument is the context.
    // Everything before it is detail. Getting this wrong would put the class
    // name in the payload and the payload nowhere.
    const trailing = rest.length > 0 ? rest[rest.length - 1] : undefined;
    const context = typeof trailing === 'string' ? trailing : null;
    const detailParts = typeof trailing === 'string' ? rest.slice(0, -1) : rest;
    const detail = detailParts.length === 0 ? undefined : detailParts.length === 1 ? detailParts[0] : detailParts;

    // `currentCorrelationId()` is `string | undefined` outside a request
    // context -- a boot-time log line, or a background sweep that ran before
    // one was established. Normalised here so the record's shape has one
    // absent-value representation rather than two.
    const record = buildLogRecord(level, message, context, detail, new Date().toISOString(), currentCorrelationId() ?? null);

    if (this.format === 'json') {
      this.sink(JSON.stringify(record));
      return;
    }

    const correlation = record.correlation ? ` [${record.correlation}]` : '';
    const where = record.context ? ` [${record.context}]` : '';
    const extra = record.detail === undefined ? '' : ` ${JSON.stringify(record.detail)}`;
    this.sink(`${record.timestamp} ${level.toUpperCase()}${where}${correlation} ${record.message}${extra}`);
  }
}
