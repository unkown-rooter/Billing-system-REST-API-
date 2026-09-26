import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../services/auth.service.js';
import { AuthenticationRequiredError } from '../services/errors.js';

export class AuthController {
  constructor(private readonly authService: AuthService) {}

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const account = await this.authService.register(req.body);
      res.status(201)
        .location('/api/v1/auth/me')
        .json({
          status: 'success',
          data: account,
        });
    } catch (err) {
      next(err);
    }
  };

  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const authResult = await this.authService.login(req.body);
      res.status(200).json({
        status: 'success',
        data: authResult,
      });
    } catch (err) {
      next(err);
    }
  };

  getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication required to access user profile');
      }
      const account = await this.authService.getAccountById(req.user.id);
      res.status(200).json({
        status: 'success',
        data: account,
      });
    } catch (err) {
      next(err);
    }
  };
}
