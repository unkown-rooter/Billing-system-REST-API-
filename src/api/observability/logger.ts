import { redactSensitiveObject, redactSensitiveText } from '../security/redaction.js';
import { getRequestContext } from './request-context.js';

/**
 * Structured Production Logger (Phase 12)
 *
 * Emits single-line, machine-parsable JSON log records with:
 * - ISO 8601 UTC `timestamp`
 * - Standardized `level`: 'debug' | 'info' | 'warn' | 'error'
 * - Machine-searchable `event` identifier (e.g. 'http_request', 'auth_login_failed', 'db_query_error')
 * - Automatic `requestId` correlation from AsyncLocalStorage when inside a request lifecycle
 * - Deep sensitive-data redaction across messages and metadata fields
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  message: string;
  requestId?: string;
  [key: string]: unknown;
}

const MAX_RECENT_LOGS = 200;
const recentLogsBuffer: StructuredLogEntry[] = [];
let customLogSink: ((entry: StructuredLogEntry) => void) | null = null;

export function resolveConfiguredLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL || '').trim().toLowerCase();
  if (raw === 'debug') {
    // Do not expose debug-level logs in production mode
    return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
  }
  if (raw === 'warn' || raw === 'error' || raw === 'info') {
    return raw;
  }
  return 'info';
}

function shouldEmit(level: LogLevel): boolean {
  const threshold = LOG_LEVEL_PRIORITY[resolveConfiguredLogLevel()];
  return LOG_LEVEL_PRIORITY[level] >= threshold;
}

function writeStructuredLog(
  level: LogLevel,
  event: string,
  message: string,
  meta: Record<string, unknown> = {}
): StructuredLogEntry | null {
  if (!shouldEmit(level)) {
    return null;
  }

  const ctx = getRequestContext();
  const sanitizedMeta = redactSensitiveObject(meta);
  const resolvedRequestId =
    (typeof sanitizedMeta.requestId === 'string' && sanitizedMeta.requestId) ||
    ctx?.requestId;

  const entry: StructuredLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    event: redactSensitiveText(event),
    ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
    ...sanitizedMeta,
    message: redactSensitiveText(message),
  };

  recentLogsBuffer.push(entry);
  if (recentLogsBuffer.length > MAX_RECENT_LOGS) {
    recentLogsBuffer.shift();
  }

  if (customLogSink) {
    customLogSink(entry);
  }

  const serialized = JSON.stringify(entry);
  if (level === 'error') {
    console.error(serialized);
  } else {
    console.log(serialized);
  }

  return entry;
}

export const logger = {
  debug(event: string, message: string, meta?: Record<string, unknown>): StructuredLogEntry | null {
    return writeStructuredLog('debug', event, message, meta);
  },
  info(event: string, message: string, meta?: Record<string, unknown>): StructuredLogEntry | null {
    return writeStructuredLog('info', event, message, meta);
  },
  warn(event: string, message: string, meta?: Record<string, unknown>): StructuredLogEntry | null {
    return writeStructuredLog('warn', event, message, meta);
  },
  error(event: string, message: string, meta?: Record<string, unknown>): StructuredLogEntry | null {
    return writeStructuredLog('error', event, message, meta);
  },
};

/**
 * Returns a snapshot of recent structured log entries from the bounded in-memory ring buffer.
 */
export function getRecentStructuredLogs(): StructuredLogEntry[] {
  return [...recentLogsBuffer];
}

export function clearRecentStructuredLogs(): void {
  recentLogsBuffer.length = 0;
}

export function setCustomLogSink(sink: ((entry: StructuredLogEntry) => void) | null): void {
  customLogSink = sink;
}
