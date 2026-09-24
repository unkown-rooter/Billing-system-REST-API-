import { Request, Response, NextFunction } from 'express';
import { CustomerService } from '../services/customer.service.js';

export class CustomerController {
  constructor(private readonly customerService: CustomerService) {}

  getAll = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const customers = await this.customerService.getAllCustomers();
      res.status(200).json({
        status: 'success',
        data: customers,
      });
    } catch (err) {
      next(err);
    }
  };

  getById = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const customer = await this.customerService.getCustomerById(req.params.id);
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
      const customer = await this.customerService.createCustomer(req.body);
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
      const customer = await this.customerService.updateCustomer(req.params.id, req.body);
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
      await this.customerService.deleteCustomer(req.params.id);
      // HTTP 204 No Content MUST NOT return a message body
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
