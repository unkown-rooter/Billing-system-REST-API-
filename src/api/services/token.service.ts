import crypto from 'node:crypto';
import {
  InvalidTokenError,
  TokenExpiredError,
  SecurityConfigurationError,
} from './errors.js';
import { AccountRole, DEFAULT_ACCOUNT_ROLE, isValidAccountRole } from '../models/account.model.js';

export const MIN_JWT_SECRET_LENGTH = 32;
export const MAX_TOKEN_LENGTH = 4096;
export const DEFAULT_JWT_EXPIRES_IN_SECONDS = 86400; // 24 hours
export const MIN_JWT_EXPIRES_IN_SECONDS = 1;
export const MAX_JWT_EXPIRES_IN_SECONDS = 2_592_000; // 30 days (30 * 24 * 60 * 60)

const DEV_FALLBACK_JWT_SECRET =
  'billing-api-development-secret-key-do-not-use-in-production-min32chars';

export const DEV_COMPOSE_FALLBACK_JWT_SECRET =
  'dev-only-local-compose-jwt-secret-do-not-use-in-production';

const INSECURE_PLACEHOLDER_SECRETS = new Set([
  'MY_JWT_SECRET',
  'changeme',
  'secret',
  'password',
  'default',
  DEV_FALLBACK_JWT_SECRET,
  DEV_COMPOSE_FALLBACK_JWT_SECRET,
  'local-compose-jwt-secret-key-minimum-32-chars-override-in-prod',
  'dev-only-jwt-secret-replace-before-production-min-32-chars',
]);

export interface JwtPayload {
  sub: string; // Account ID (e.g. acc_<uuid>)
  email: string;
  role: AccountRole; // Account role ('user' | 'admin')
  iat: number; // Issued at (Unix seconds)
  exp: number; // Expiration (Unix seconds)
}

export interface TokenServiceConfig {
  secret?: string;
  expiresInSeconds?: number;
  nodeEnv?: string;
}

export interface GenerateTokenOptions {
  issuedAtSeconds?: number;
}

/**
 * Validates JWT signing secret strength.
 * In production mode (NODE_ENV === 'production'), fails closed if JWT_SECRET is missing,
 * shorter than 32 characters, or set to a known placeholder/development fallback key.
 */
export function resolveAndValidateJwtSecret(
  configuredSecret?: string,
  nodeEnv: string = process.env.NODE_ENV ?? 'development'
): string {
  const isProduction = nodeEnv === 'production';
  const rawSecret = configuredSecret ?? process.env.JWT_SECRET;

  if (isProduction) {
    if (!rawSecret || typeof rawSecret !== 'string' || rawSecret.trim().length === 0) {
      throw new SecurityConfigurationError(
        'Production security error: JWT_SECRET environment variable must be explicitly set in production'
      );
    }
    if (INSECURE_PLACEHOLDER_SECRETS.has(rawSecret.trim())) {
      throw new SecurityConfigurationError(
        'Production security error: JWT_SECRET cannot use a placeholder or development fallback value in production'
      );
    }
    if (rawSecret.trim().length < MIN_JWT_SECRET_LENGTH) {
      throw new SecurityConfigurationError(
        `Production security error: JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long`
      );
    }
    return rawSecret;
  }

  // Non-production: if an explicit non-placeholder secret is provided, use it; otherwise use dev fallback
  if (rawSecret && rawSecret.trim().length >= MIN_JWT_SECRET_LENGTH && rawSecret.trim() !== 'MY_JWT_SECRET') {
    return rawSecret;
  }

  return configuredSecret && configuredSecret.trim().length > 0
    ? configuredSecret
    : DEV_FALLBACK_JWT_SECRET;
}

/**
 * Validates JWT expiration configuration (`TokenServiceConfig.expiresInSeconds` or `JWT_EXPIRES_IN`).
 * Accepts only finite positive integers within [1, 2_592_000] seconds (up to 30 days).
 * Uses the 24-hour default (86,400s) only when the configuration is missing (`undefined`).
 * Never silently accepts malformed, zero, negative, decimal, non-numeric, or excessively large values.
 */
export function resolveAndValidateJwtExpiresIn(
  configuredExpiresIn?: number,
  envExpiresIn: string | undefined = process.env.JWT_EXPIRES_IN,
  nodeEnv: string = process.env.NODE_ENV ?? 'development'
): number {
  const prefix =
    nodeEnv === 'production'
      ? 'Production security error'
      : 'Invalid JWT expiration configuration';

  if (configuredExpiresIn !== undefined) {
    if (
      typeof configuredExpiresIn !== 'number' ||
      !Number.isFinite(configuredExpiresIn) ||
      !Number.isInteger(configuredExpiresIn) ||
      configuredExpiresIn < MIN_JWT_EXPIRES_IN_SECONDS ||
      configuredExpiresIn > MAX_JWT_EXPIRES_IN_SECONDS
    ) {
      throw new SecurityConfigurationError(
        `${prefix}: expiresInSeconds must be a finite integer between ${MIN_JWT_EXPIRES_IN_SECONDS} and ${MAX_JWT_EXPIRES_IN_SECONDS} seconds`
      );
    }
    return configuredExpiresIn;
  }

  if (envExpiresIn === undefined) {
    return DEFAULT_JWT_EXPIRES_IN_SECONDS;
  }

  if (typeof envExpiresIn !== 'string') {
    throw new SecurityConfigurationError(
      `${prefix}: JWT_EXPIRES_IN must be a positive integer between ${MIN_JWT_EXPIRES_IN_SECONDS} and ${MAX_JWT_EXPIRES_IN_SECONDS} seconds`
    );
  }

  const trimmed = envExpiresIn.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new SecurityConfigurationError(
      `${prefix}: JWT_EXPIRES_IN must be a positive integer between ${MIN_JWT_EXPIRES_IN_SECONDS} and ${MAX_JWT_EXPIRES_IN_SECONDS} seconds`
    );
  }

  const parsed = Number(trimmed);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_JWT_EXPIRES_IN_SECONDS ||
    parsed > MAX_JWT_EXPIRES_IN_SECONDS
  ) {
    throw new SecurityConfigurationError(
      `${prefix}: JWT_EXPIRES_IN must be a finite integer between ${MIN_JWT_EXPIRES_IN_SECONDS} and ${MAX_JWT_EXPIRES_IN_SECONDS} seconds`
    );
  }

  return parsed;
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Token Service
 * Implements RFC 7519 JSON Web Token (JWT) issuing and cryptographic verification.
 * 
 * Cryptographic Architecture:
 * - Algorithm: HMAC with SHA-256 (HS256).
 * - Constant-time signature comparison prevents byte-by-byte timing attacks.
 * - Minimal payload claims: `sub` (Account ID), `email`, `iat`, and `exp`.
 * - No sensitive credentials or secrets stored in payload.
 * - Enforces explicit expiration time window.
 */
export class TokenService {
  private readonly secret: string;
  private readonly expiresInSeconds: number;

  constructor(config?: TokenServiceConfig) {
    const nodeEnv = config?.nodeEnv ?? process.env.NODE_ENV ?? 'development';
    this.secret = resolveAndValidateJwtSecret(config?.secret, nodeEnv);
    this.expiresInSeconds = resolveAndValidateJwtExpiresIn(
      config?.expiresInSeconds,
      process.env.JWT_EXPIRES_IN,
      nodeEnv
    );
  }

  getExpiresInSeconds(): number {
    return this.expiresInSeconds;
  }

  /**
   * Generates a signed JWT Bearer token for an account identity.
   */
  generateToken(
    account: { id: string; email: string; role?: AccountRole },
    options?: GenerateTokenOptions
  ): string {
    const now = options?.issuedAtSeconds ?? Math.floor(Date.now() / 1000);
    if (typeof now !== 'number' || !Number.isFinite(now) || !Number.isInteger(now) || now <= 0) {
      throw new InvalidTokenError('Invalid token issue timestamp (iat)');
    }
    if (
      typeof this.expiresInSeconds !== 'number' ||
      !Number.isFinite(this.expiresInSeconds) ||
      !Number.isInteger(this.expiresInSeconds) ||
      this.expiresInSeconds < MIN_JWT_EXPIRES_IN_SECONDS ||
      this.expiresInSeconds > MAX_JWT_EXPIRES_IN_SECONDS
    ) {
      throw new SecurityConfigurationError(
        `Invalid JWT expiration configuration: expiresInSeconds must be a finite integer between ${MIN_JWT_EXPIRES_IN_SECONDS} and ${MAX_JWT_EXPIRES_IN_SECONDS} seconds`
      );
    }

    const exp = now + this.expiresInSeconds;
    if (!Number.isFinite(exp) || !Number.isInteger(exp) || exp <= now) {
      throw new InvalidTokenError('Invalid token expiration timestamp (exp)');
    }
    const role: AccountRole = account.role ?? DEFAULT_ACCOUNT_ROLE;

    if (!isValidAccountRole(role)) {
      throw new InvalidTokenError('Invalid role specified for token generation');
    }

    const header = {
      alg: 'HS256',
      typ: 'JWT',
    };

    const payload: JwtPayload = {
      sub: account.id,
      email: account.email,
      role,
      iat: now,
      exp,
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto
      .createHmac('sha256', this.secret)
      .update(signingInput)
      .digest();

    const encodedSignature = base64UrlEncode(signature);

    return `${signingInput}.${encodedSignature}`;
  }

  /**
   * Verifies and decodes a JWT string.
   * Throws `TokenExpiredError` if expired, or `InvalidTokenError` if tampered/malformed.
   */
  verifyToken(token: string): JwtPayload {
    if (!token || typeof token !== 'string') {
      throw new InvalidTokenError('Authentication token is missing or invalid');
    }

    if (token.length > MAX_TOKEN_LENGTH) {
      throw new InvalidTokenError('Authentication token exceeds maximum permitted length');
    }

    const parts = token.split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw new InvalidTokenError('Malformed authentication token structure');
    }

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    // 1. Verify cryptographic HMAC-SHA256 signature
    const expectedSignature = crypto
      .createHmac('sha256', this.secret)
      .update(signingInput)
      .digest();

    let actualSignature: Buffer;
    try {
      let base64 = encodedSignature.replace(/-/g, '+').replace(/_/g, '/');
      while (base64.length % 4 !== 0) {
        base64 += '=';
      }
      actualSignature = Buffer.from(base64, 'base64');
    } catch {
      throw new InvalidTokenError('Invalid token signature encoding');
    }

    if (actualSignature.length !== expectedSignature.length) {
      throw new InvalidTokenError('Invalid token signature');
    }

    if (!crypto.timingSafeEqual(actualSignature, expectedSignature)) {
      throw new InvalidTokenError('Invalid token signature');
    }

    // 2. Parse and validate header
    try {
      const headerJson = JSON.parse(base64UrlDecode(encodedHeader));
      if (
        !headerJson ||
        typeof headerJson !== 'object' ||
        headerJson.alg !== 'HS256' ||
        headerJson.typ !== 'JWT'
      ) {
        throw new InvalidTokenError('Unsupported token algorithm or type');
      }
    } catch (err) {
      if (err instanceof InvalidTokenError) throw err;
      throw new InvalidTokenError('Invalid token header');
    }

    // 3. Parse and validate payload
    let payload: JwtPayload;
    try {
      payload = JSON.parse(base64UrlDecode(encodedPayload));
    } catch {
      throw new InvalidTokenError('Invalid token payload');
    }

    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.sub !== 'string' ||
      payload.sub.trim().length === 0 ||
      typeof payload.email !== 'string' ||
      payload.email.trim().length === 0 ||
      !isValidAccountRole(payload.role) ||
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp)
    ) {
      throw new InvalidTokenError('Token payload is missing required identity claims');
    }

    // 4. Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) {
      throw new TokenExpiredError('Authentication token has expired');
    }

    return payload;
  }
}
