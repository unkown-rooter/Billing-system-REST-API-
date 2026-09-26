import { Request, Response, NextFunction } from 'express';
import { InvoiceService } from '../services/invoice.service.js';
import { AuthenticationRequiredError } from '../services/errors.js';
import {
  validateInvoiceListQuery,
  validateInvoiceItemListQuery,
} from '../validation/query.schema.js';

export class InvoiceController {
  constructor(private readonly invoiceService: InvoiceService) {}

  getAll = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const query =
        req.validatedInvoiceQuery ||
        validateInvoiceListQuery(req.query, { allowCustomerIdParam: true });
      const result = await this.invoiceService.listInvoices(query, req.user);
      res.status(200).json({
        status: 'success',
        data: result.items,
        pagination: result.pagination,
      });
    } catch (err) {
      next(err);
    }
  };

  getByCustomerId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const query =
        req.validatedInvoiceQuery ||
        validateInvoiceListQuery(req.query, { allowCustomerIdParam: false });
      const result = await this.invoiceService.listCustomerInvoices(
        req.params.id,
        query,
        req.user
      );
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
      const invoice = await this.invoiceService.getInvoiceById(req.params.id, req.user);
      res.status(200).json({
        status: 'success',
        data: invoice,
      });
    } catch (err) {
      next(err);
    }
  };

  getItemsByInvoiceId = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const query =
        req.validatedInvoiceItemQuery || validateInvoiceItemListQuery(req.query);
      const result = await this.invoiceService.listInvoiceItems(
        req.params.id,
        query,
        req.user
      );
      res.status(200).json({
        status: 'success',
        data: result.items,
        pagination: result.pagination,
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
      const invoice = await this.invoiceService.createInvoice(req.body, req.user);
      res.status(201)
        .location(`/api/v1/invoices/${invoice.id}`)
        .json({
          status: 'success',
          data: invoice,
        });
    } catch (err) {
      next(err);
    }
  };

  createForCustomer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (!req.user) {
        throw new AuthenticationRequiredError('Authentication is required');
      }
      const invoice = await this.invoiceService.createInvoice(
        {
          ...req.body,
          customerId: req.params.id,
        },
        req.user
      );
      res.status(201)
        .location(`/api/v1/invoices/${invoice.id}`)
        .json({
          status: 'success',
          data: invoice,
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
      const invoice = await this.invoiceService.updateInvoice(req.params.id, req.body, req.user);
      res.status(200).json({
        status: 'success',
        data: invoice,
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
      await this.invoiceService.deleteInvoice(req.params.id, req.user);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  };
}
