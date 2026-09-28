/**
 * Security Logging Redaction & Sanitization Utilities (Phase 9)
 *
 * Ensures that operational logs, request logs, and error logs never expose:
 * - Plaintext passwords or password hashes (scrypt$...)
 * - Authorization headers or Bearer JWT tokens
 * - Database connection strings containing credentials (postgresql://user:pass@...)
 * - Sensitive query parameters (?token=..., ?password=..., ?secret=...)
 * - CRLF control characters (\r, \n) that could enable log injection attacks
 */

const SENSITIVE_QUERY_PARAM_REGEX =
  /([?&](?:password|password_hash|passwordHash|token|access_token|refresh_token|secret|jwt|authorization|api_key|apiKey|credential)=)([^&#\s]*)/gi;

const BEARER_TOKEN_REGEX = /\b(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi;

const POSTGRES_URI_REGEX = /\b(postgres(?:ql)?:\/\/[^:\s/]+:)([^@\s]+)(@)/gi;

const SCRYPT_HASH_REGEX = /\bscrypt\$[^\s"']+/gi;

const KEY_VALUE_SECRET_REGEX =
  /\b(password|password_hash|passwordHash|jwt_secret|JWT_SECRET|secret|token|authorization)(\s*[:=]\s*["']?)([^"'\s,};]+)(["']?)/gi;

const RAW_JWT_REGEX = /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;

const SENSITIVE_OBJECT_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'authorization',
  'secret',
  'jwtsecret',
  'jwt_secret',
  'databaseurl',
  'database_url',
  'connectionstring',
  'api_key',
  'apikey',
  'credential',
]);

/**
 * Strips CR/LF and control characters to prevent log-forging / CRLF injection.
 */
export function stripControlChars(input: string): string {
  return input.replace(/[\r\n\x00-\x1f\x7f]+/g, ' ');
}

/**
 * Redacts sensitive query string parameters and control characters from a request URL
 * before writing it to operational access logs.
 */
export function redactSensitiveUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }
  const cleanUrl = stripControlChars(rawUrl);
  try {
    const decoded = decodeURIComponent(cleanUrl);
    const redactedDecoded = decoded.replace(SENSITIVE_QUERY_PARAM_REGEX, '$1[REDACTED]');
    if (redactedDecoded !== decoded) {
      return stripControlChars(redactedDecoded);
    }
  } catch {
    // Ignore malformed URI encoding and fall back to raw regex redaction
  }
  return cleanUrl.replace(SENSITIVE_QUERY_PARAM_REGEX, '$1[REDACTED]');
}

/**
 * Redacts credentials, tokens, password hashes, and connection strings from arbitrary log text.
 */
export function redactSensitiveText(input: string): string {
  if (!input || typeof input !== 'string') {
    return '';
  }
  return stripControlChars(input)
    .replace(POSTGRES_URI_REGEX, '$1[REDACTED]$3')
    .replace(BEARER_TOKEN_REGEX, '$1[REDACTED]')
    .replace(RAW_JWT_REGEX, '[REDACTED_JWT]')
    .replace(SCRYPT_HASH_REGEX, 'scrypt$[REDACTED]')
    .replace(SENSITIVE_QUERY_PARAM_REGEX, '$1[REDACTED]')
    .replace(KEY_VALUE_SECRET_REGEX, '$1$2[REDACTED]$4');
}

/**
 * Recursively sanitizes structured log metadata objects so sensitive keys or embedded
 * credentials/tokens are redacted before JSON serialization.
 */
export function redactSensitiveObject<T>(value: T, depth = 0): T {
  if (depth > 5 || value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value) as unknown as T;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveObject(item, depth + 1)) as unknown as T;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (SENSITIVE_OBJECT_KEYS.has(normalizedKey)) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = redactSensitiveObject(val, depth + 1);
    }
  }
  return sanitized as unknown as T;
}
