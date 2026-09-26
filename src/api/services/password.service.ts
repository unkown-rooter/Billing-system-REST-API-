import crypto from 'node:crypto';

function scryptAsync(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(derivedKey as Buffer);
    });
  });
}

export interface PasswordHashOptions {
  N?: number; // CPU/memory cost parameter (must be power of 2)
  r?: number; // Block size parameter
  p?: number; // Parallelization parameter
  keyLength?: number; // Length of derived key in bytes
}

const DEFAULT_OPTIONS: Required<PasswordHashOptions> = {
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 64,
};

/**
 * Password Security Service
 * Implements cryptographically secure, memory-hard password hashing using scrypt.
 * 
 * Cryptographic Rationale:
 * - Recommended by OWASP Password Storage Guidelines.
 * - Memory-hard function designed to resist hardware brute-force attacks (GPUs/ASICs).
 * - Cryptographically random 16-byte salt per password eliminates rainbow table attacks.
 * - Constant-time verification (timingSafeEqual) eliminates byte-by-byte timing leaks.
 * - Dummy verification mitigates timing-based account enumeration on nonexistent users.
 */
export class PasswordService {
  private readonly options: Required<PasswordHashOptions>;
  // Pre-computed dummy hash used to neutralize timing attacks during account enumeration attempts
  private readonly dummyHash: string;

  constructor(options?: PasswordHashOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    // Pre-calculate a standard scrypt format string for timing-neutral dummy checks
    const dummySalt = crypto.randomBytes(16).toString('hex');
    const dummyDerived = crypto.randomBytes(this.options.keyLength).toString('hex');
    this.dummyHash = `scrypt$N=${this.options.N},r=${this.options.r},p=${this.options.p}$${dummySalt}$${dummyDerived}`;
  }

  /**
   * Hashes a plaintext password with a unique, cryptographically random salt.
   * Returns formatted string: `scrypt$N=<n>,r=<r>,p=<p>$<saltHex>$<derivedKeyHex>`
   */
  async hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString('hex');
    const derivedKey = (await scryptAsync(password, salt, this.options.keyLength, {
      N: this.options.N,
      r: this.options.r,
      p: this.options.p,
    })) as Buffer;

    return `scrypt$N=${this.options.N},r=${this.options.r},p=${this.options.p}$${salt}$${derivedKey.toString('hex')}`;
  }

  /**
   * Verifies a candidate password against a stored scrypt hash string using timingSafeEqual.
   * Never throws on mismatched credentials; returns true/false.
   */
  async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    try {
      const parts = storedHash.split('$');
      if (parts.length !== 4 || parts[0] !== 'scrypt') {
        return false;
      }

      const paramsPart = parts[1]; // e.g. "N=16384,r=8,p=1"
      const salt = parts[2];
      const expectedKeyHex = parts[3];

      const params: Record<string, number> = {};
      for (const pair of paramsPart.split(',')) {
        const [k, v] = pair.split('=');
        if (k && v) {
          params[k] = parseInt(v, 10);
        }
      }

      const N = params.N || this.options.N;
      const r = params.r || this.options.r;
      const p = params.p || this.options.p;
      const expectedKey = Buffer.from(expectedKeyHex, 'hex');

      const actualKey = (await scryptAsync(password, salt, expectedKey.length, {
        N,
        r,
        p,
      })) as Buffer;

      if (actualKey.length !== expectedKey.length) {
        return false;
      }

      return crypto.timingSafeEqual(actualKey, expectedKey);
    } catch {
      return false;
    }
  }

  /**
   * Performs an equivalent-cost derivation against the pre-computed dummy hash.
   * Ensures that login timing when an account is nonexistent is indistinguishable from
   * an existing account with an incorrect password.
   */
  async dummyVerify(password: string): Promise<boolean> {
    await this.verifyPassword(password, this.dummyHash);
    return false;
  }
}
