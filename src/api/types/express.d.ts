import { AuthenticatedUser } from '../models/account.model.js';
import {
  CustomerListQuery,
  InvoiceListQuery,
  InvoiceItemListQuery,
} from '../models/pagination.model.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      validatedCustomerQuery?: CustomerListQuery;
      validatedInvoiceQuery?: InvoiceListQuery;
      validatedInvoiceItemQuery?: InvoiceItemListQuery;
    }
  }
}
