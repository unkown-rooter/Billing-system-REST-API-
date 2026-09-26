import { Request, Response, NextFunction } from 'express';
import { CustomerService } from '../services/customer.service.js';
import { AuthenticationRequiredError } from '../services/errors.js';
import { validateCustomerListQuery } from '../validation/query.schema.js';

export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  getAll = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const query = req.validatedCustomerQuery || validateCustomerListQuery(req.query);
      const result = await this.customerService.listCustomers(query, req.user);
      res.status(200).json({
        status: 'success',
        data: result.items,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const customer = await this.customerService.getCustomerById(req.params.id, req.user);
      res.status(200).json({
        status: 'success',
        data: customer,
      });
    } catch (err) {
      next(err);
    }
  };

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const customer = await this.customerService.createCustomer(req.body, req.user);
      res.status(201)
        .location(`/api/v1/customers/${customer.id}`)
        .json({
          status: 'success',
          data: customer,
        });
    } catch (err) {
      next(err);
    }
  };

  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const customer = await this.customerService.updateCustomer(req.params.id, req.body, req.user);
      res.status(200).json({
        status: 'success',
        data: customer,
      });
    } catch (err) {
      next(err);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      await this.customerService.deleteCustomer(req.params.id, req.user);
      // HTTP 204 No Content MUST NOT return a message body
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
