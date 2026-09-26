import { randomUUID } from 'node:crypto';
import {
  Account,
  AccountDTO,
  DEFAULT_ACCOUNT_ROLE,
  RegisterDTO,
  LoginDTO,
  AuthTokenResponse,
} from '../models/account.model.js';
import { IAccountRepository } from '../repositories/account.repository.interface.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';
import {
  DuplicateResourceError,
  InvalidCredentialsError,
  NotFoundError,
} from './errors.js';

/**
 * Authentication & Identity Service
 * Handles registration, credential verification, and token issuance.
 * 
 * Security Invariants:
 * - Passwords are never stored in plaintext.
 * - Password hashes are never returned through API responses.
 * - Registration always assigns the least-privileged default role ('user') server-side.
 * - Login failures use a single generic response to prevent account enumeration.
 * - Nonexistent accounts invoke dummy password hashing to prevent timing leaks.
 */
export class AuthService {
  constructor(
    private readonly accountRepo: IAccountRepository,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService
  ) {}

  /**
   * Transforms an internal Account entity into a safe public DTO.
   * Strictly strips passwordHash.
   */
  private toDTO(account: Account): AccountDTO {
    return {
      id: account.id,
      email: account.email,
      role: account.role,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  /**
   * Generates a collision-resistant, domain-prefixed Account ID.
   * Format: `acc_<uuidv4>`
   */
  private generateId(): string {
    return `acc_${randomUUID()}`;
  }

  /**
   * Registers a new authentication account.
   * Enforces server-side assignment of the least-privileged default role ('user').
   */
  async register(dto: RegisterDTO): Promise<AccountDTO> {
    const normalizedEmail = dto.email.trim().toLowerCase();

    // Check for existing account with this email
    const existing = await this.accountRepo.findByEmail(normalizedEmail);
    if (existing) {
      throw new DuplicateResourceError(`An account with email '${normalizedEmail}' already exists`);
    }

    // Cryptographically hash password with unique salt
    const passwordHash = await this.passwordService.hashPassword(dto.password);

    const now = new Date().toISOString();
    const newAccount: Account = {
      id: this.generateId(),
      email: normalizedEmail,
      passwordHash,
      role: DEFAULT_ACCOUNT_ROLE,
      createdAt: now,
      updatedAt: now,
    };

    const saved = await this.accountRepo.create(newAccount);
    return this.toDTO(saved);
  }

  /**
   * Authenticates an account using email and password, issuing a signed JWT Bearer token.
   * Protects against account enumeration via timing-safe dummy hash execution.
   */
  async login(dto: LoginDTO): Promise<AuthTokenResponse> {
    const normalizedEmail = dto.email.trim().toLowerCase();
    const account = await this.accountRepo.findByEmail(normalizedEmail);

    if (!account) {
      // Neutralize timing attacks by executing a real scrypt derivation
      await this.passwordService.dummyVerify(dto.password);
      throw new InvalidCredentialsError('Invalid email or password');
    }

    const isValid = await this.passwordService.verifyPassword(dto.password, account.passwordHash);
    if (!isValid) {
      throw new InvalidCredentialsError('Invalid email or password');
    }

    const token = this.tokenService.generateToken({
      id: account.id,
      email: account.email,
      role: account.role,
    });

    return {
      token,
      tokenType: 'Bearer',
      expiresIn: this.tokenService.getExpiresInSeconds(),
      account: this.toDTO(account),
    };
  }

  /**
   * Retrieves an account by ID and returns its safe DTO representation.
   */
  async getAccountById(id: string): Promise<AccountDTO> {
    const account = await this.accountRepo.findById(id);
    if (!account) {
      throw new NotFoundError(`Account with ID '${id}' not found`);
    }
    return this.toDTO(account);
  }
}
