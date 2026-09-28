import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Plus,
  Search,
  RefreshCw,
  Edit3,
  Trash2,
  LogOut,
  FileText,
  Users,
  LayoutDashboard,
  ChevronRight,
  X,
  Check,
  AlertCircle,
  ArrowUpDown,
  Scale
} from 'lucide-react';

type InvoiceStatus = 'draft' | 'issued' | 'paid' | 'overdue' | 'cancelled';

interface Account {
  id: string;
  email: string;
  role: 'user' | 'admin';
  createdAt: string;
  updatedAt: string;
}

interface Customer {
  id: string;
  accountId: string;
  name: string;
  email: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

interface InvoiceItem {
  id: string;
  invoiceId: string;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  createdAt: string;
  updatedAt: string;
}

interface Invoice {
  id: string;
  customerId: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  currency: string;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  issueDate: string;
  dueDate: string;
  notes: string | null;
  items: InvoiceItem[];
  createdAt: string;
  updatedAt: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

interface ApiResponse<T = unknown> {
  status: 'success' | 'error';
  data?: T;
  pagination?: PaginationMeta;
  error?: {
    code: string;
    message: string;
    fields?: Array<{ field: string; message: string }>;
  };
}

interface DraftLineItem {
  description: string;
  quantity: string;
  unitPrice: string;
}

const MIT_LICENSE_TEXT = `MIT License

Copyright (c) 2026 [G7 COMMUNITY]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'KES', 'CAD', 'AUD', 'JPY'];

function formatMoney(amount: number, currency: string = 'USD'): string {
  const safeAmount = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(safeAmount);
  } catch {
    return `${currency} ${safeAmount.toFixed(2)}`;
  }
}

function formatDateShort(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function getStatusColorClass(status: InvoiceStatus): string {
  switch (status) {
    case 'paid':
      return 'text-emerald-700 font-semibold';
    case 'issued':
      return 'text-blue-700 font-semibold';
    case 'overdue':
      return 'text-red-700 font-semibold';
    case 'cancelled':
      return 'text-slate-400 line-through';
    case 'draft':
    default:
      return 'text-amber-700 font-medium';
  }
}

function getStatusLabel(status: InvoiceStatus): string {
  switch (status) {
    case 'paid':
      return 'Paid';
    case 'issued':
      return 'Issued';
    case 'overdue':
      return 'Overdue';
    case 'cancelled':
      return 'Cancelled';
    case 'draft':
    default:
      return 'Draft';
  }
}

const SESSION_TOKEN_KEY = 'g7_billing_session_token';

function parseJwtClaims(token: string): { sub?: string; iat?: number; exp?: number } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = atob(base64);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function getInitialValidToken(): string | null {
  try {
    // Purge legacy key that may hold stale tokens from previous sessions
    localStorage.removeItem('billing_auth_token');
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (!token) return null;
    const claims = parseJwtClaims(token);
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !claims ||
      !claims.sub ||
      claims.sub === 'acc_g7_default_workspace' ||
      (typeof claims.exp === 'number' && claims.exp <= nowSec)
    ) {
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export default function App() {
  // Active Workspace Section
  const [activeSection, setActiveSection] = useState<'overview' | 'invoices' | 'customers'>('overview');

  // Authentication State
  const [authToken, setAuthToken] = useState<string | null>(getInitialValidToken);
  const [currentAccount, setCurrentAccount] = useState<Account | null>(null);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('register');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authNotice, setAuthNotice] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // Domain Data State
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);

  // Filters & Search — Invoices
  const [invoiceSearch, setInvoiceSearch] = useState('');
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState<'ALL' | InvoiceStatus>('ALL');
  const [invoiceCustomerFilter, setInvoiceCustomerFilter] = useState<string>('ALL');
  const [invoiceSort, setInvoiceSort] = useState<'newest' | 'due' | 'amount'>('newest');

  // Filters & Search — Customers
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerCurrencyFilter, setCustomerCurrencyFilter] = useState<string>('ALL');

  // Customer Create / Edit / Delete Modals
  const [customerModalMode, setCustomerModalMode] = useState<'create' | 'edit' | null>(null);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [custName, setCustName] = useState('');
  const [custEmail, setCustEmail] = useState('');
  const [custCurrency, setCustCurrency] = useState('USD');
  const [custFormError, setCustFormError] = useState<string | null>(null);
  const [custSubmitting, setCustSubmitting] = useState(false);
  const [deletingCustomer, setDeletingCustomer] = useState<Customer | null>(null);
  const [deleteCustomerError, setDeleteCustomerError] = useState<string | null>(null);

  // Invoice Create Modal
  const [showCreateInvoiceModal, setShowCreateInvoiceModal] = useState(false);
  const [invCustomerId, setInvCustomerId] = useState('');
  const [invStatus, setInvStatus] = useState<InvoiceStatus>('issued');
  const [invTax, setInvTax] = useState('0.00');
  const [invDiscount, setInvDiscount] = useState('0.00');
  const [invDueDate, setInvDueDate] = useState(() => {
    const d = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [invNotes, setInvNotes] = useState('');
  const [invItems, setInvItems] = useState<DraftLineItem[]>([
    { description: '', quantity: '1', unitPrice: '100.00' },
  ]);
  const [invFormError, setInvFormError] = useState<string | null>(null);
  const [invSubmitting, setInvSubmitting] = useState(false);

  // Invoice Detail / Update / Delete Modal
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [invoiceActionError, setInvoiceActionError] = useState<string | null>(null);
  const [invoiceActionLoading, setInvoiceActionLoading] = useState(false);

  // License Modal
  const [showLicenseModal, setShowLicenseModal] = useState(false);

  // Customer Map by ID
  const customerMap = useMemo(() => {
    const map = new Map<string, Customer>();
    for (const c of customers) {
      map.set(c.id, c);
    }
    return map;
  }, [customers]);

  // Fetch Authenticated Account & Ledger Data from Backend / Database
  const loadWorkspaceData = useCallback(async (token: string | null) => {
    if (!token) {
      setCurrentAccount(null);
      setCustomers([]);
      setInvoices([]);
      return;
    }

    const claims = parseJwtClaims(token);
    const nowSec = Math.floor(Date.now() / 1000);
    if (
      !claims ||
      !claims.sub ||
      claims.sub === 'acc_g7_default_workspace' ||
      (typeof claims.exp === 'number' && claims.exp <= nowSec)
    ) {
      setAuthToken(null);
      setCurrentAccount(null);
      setCustomers([]);
      setInvoices([]);
      sessionStorage.removeItem(SESSION_TOKEN_KEY);
      localStorage.removeItem('billing_auth_token');
      return;
    }

    setLoadingData(true);
    setBannerError(null);

    try {
      // Check server liveness uptime first so tokens from a prior server restart are discarded cleanly
      const liveRes = await fetch('/api/v1/health/live');
      if (liveRes.ok) {
        const liveJson: ApiResponse<{ uptime: number }> = await liveRes.json();
        const uptime = liveJson.data?.uptime;
        if (typeof uptime === 'number' && typeof claims.iat === 'number') {
          const serverBootSec = Math.floor(Date.now() / 1000 - uptime);
          if (claims.iat < serverBootSec - 2) {
            setAuthToken(null);
            setCurrentAccount(null);
            setCustomers([]);
            setInvoices([]);
            sessionStorage.removeItem(SESSION_TOKEN_KEY);
            localStorage.removeItem('billing_auth_token');
            setLoadingData(false);
            return;
          }
        }
      }

      const headers = { Authorization: `Bearer ${token}` };
      const [meRes, custRes, invRes] = await Promise.all([
        fetch('/api/v1/auth/me', { headers }),
        fetch('/api/v1/customers?page=1&limit=100&sort=createdAt&order=desc', { headers }),
        fetch('/api/v1/invoices?page=1&limit=100&sort=createdAt&order=desc', { headers }),
      ]);

      if (!meRes.ok) {
        setAuthToken(null);
        setCurrentAccount(null);
        setCustomers([]);
        setInvoices([]);
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem('billing_auth_token');
        setLoadingData(false);
        return;
      }

      const meJson: ApiResponse<Account> = await meRes.json();
      if (meJson.data) setCurrentAccount(meJson.data);

      if (custRes.ok) {
        const custJson: ApiResponse<Customer[]> = await custRes.json();
        if (Array.isArray(custJson.data)) setCustomers(custJson.data);
      }

      if (invRes.ok) {
        const invJson: ApiResponse<Invoice[]> = await invRes.json();
        if (Array.isArray(invJson.data)) setInvoices(invJson.data);
      }
    } catch {
      setBannerError('Unable to reach the billing server. Please check your connection and refresh.');
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaceData(authToken);
  }, [authToken, loadWorkspaceData]);

  // Sign In or Register
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError(null);
    setAuthNotice(null);

    const trimmedEmail = authEmail.trim();
    const endpoint = authMode === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: trimmedEmail,
          password: authPassword,
        }),
      });

      const json: ApiResponse<any> = await res.json();
      if (!res.ok || json.status === 'error') {
        const msg =
          json.error?.fields?.map((f) => `${f.field}: ${f.message}`).join(', ') ||
          json.error?.message ||
          'Authentication failed';
        setAuthError(msg);
        return;
      }

      if (authMode === 'register') {
        // Automatically log the user in right after registration
        const loginRes = await fetch('/api/v1/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: trimmedEmail,
            password: authPassword,
          }),
        });
        const loginJson: ApiResponse<{ token: string; account: Account }> = await loginRes.json();
        if (loginRes.ok && loginJson.data?.token) {
          setAuthToken(loginJson.data.token);
          setCurrentAccount(loginJson.data.account);
          sessionStorage.setItem(SESSION_TOKEN_KEY, loginJson.data.token);
          setAuthPassword('');
          return;
        }
        setAuthMode('login');
        setAuthNotice('Account created. Sign in with your credentials.');
        return;
      }

      if (json.data?.token) {
        setAuthToken(json.data.token);
        setCurrentAccount(json.data.account);
        sessionStorage.setItem(SESSION_TOKEN_KEY, json.data.token);
        setAuthPassword('');
      }
    } catch (err: any) {
      setAuthError(err.message || 'Network error while authenticating');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = () => {
    setAuthToken(null);
    setCurrentAccount(null);
    setCustomers([]);
    setInvoices([]);
    sessionStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem('billing_auth_token');
  };

  // Open Create Customer Modal
  const openCreateCustomerModal = () => {
    setCustomerModalMode('create');
    setEditingCustomer(null);
    setCustName('');
    setCustEmail('');
    setCustCurrency('USD');
    setCustFormError(null);
  };

  // Open Edit Customer Modal
  const openEditCustomerModal = (customer: Customer) => {
    setCustomerModalMode('edit');
    setEditingCustomer(customer);
    setCustName(customer.name);
    setCustEmail(customer.email);
    setCustCurrency(customer.currency);
    setCustFormError(null);
  };

  // Submit Create or Edit Customer
  const handleSaveCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setCustSubmitting(true);
    setCustFormError(null);

    const isEdit = customerModalMode === 'edit' && editingCustomer;
    const url = isEdit ? `/api/v1/customers/${editingCustomer.id}` : '/api/v1/customers';
    const method = isEdit ? 'PATCH' : 'POST';

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          name: custName.trim(),
          email: custEmail.trim(),
          currency: custCurrency.trim().toUpperCase(),
        }),
      });

      const json: ApiResponse<Customer> = await res.json();
      if (!res.ok || json.status === 'error') {
        const msg =
          json.error?.fields?.map((f) => `${f.field}: ${f.message}`).join(', ') ||
          json.error?.message ||
          'Could not save customer';
        setCustFormError(msg);
        return;
      }

      setCustomerModalMode(null);
      setEditingCustomer(null);
      await loadWorkspaceData(authToken);
    } catch (err: any) {
      setCustFormError(err.message || 'Network error');
    } finally {
      setCustSubmitting(false);
    }
  };

  // Delete Customer (Authoritative Backend & Database DELETE /api/v1/customers/:id)
  const handleConfirmDeleteCustomer = async () => {
    if (!deletingCustomer || !authToken) return;
    setCustSubmitting(true);
    setDeleteCustomerError(null);

    try {
      const res = await fetch(`/api/v1/customers/${deletingCustomer.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (res.status === 204 || res.ok) {
        setDeletingCustomer(null);
        await loadWorkspaceData(authToken);
        return;
      }

      const json: ApiResponse = await res.json();
      setDeleteCustomerError(
        json.error?.message || 'Unable to delete customer record.'
      );
    } catch (err: any) {
      setDeleteCustomerError(err.message || 'Network error');
    } finally {
      setCustSubmitting(false);
    }
  };

  // Open Create Invoice Modal
  const openCreateInvoice = (preselectedCustomerId?: string) => {
    if (customers.length === 0) {
      openCreateCustomerModal();
      return;
    }
    const defaultCustomerId = preselectedCustomerId || customers[0]?.id || '';
    setInvCustomerId(defaultCustomerId);
    setInvStatus('issued');
    setInvTax('0.00');
    setInvDiscount('0.00');
    const due = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    setInvDueDate(due.toISOString().slice(0, 10));
    setInvNotes('');
    setInvItems([{ description: '', quantity: '1', unitPrice: '100.00' }]);
    setInvFormError(null);
    setShowCreateInvoiceModal(true);
  };

  // Live Integer-Cents Preview for Draft Invoice Modal
  const draftFinancialPreview = useMemo(() => {
    let subtotalCents = 0;
    for (const item of invItems) {
      const qty = Math.max(0, Math.floor(Number(item.quantity) || 0));
      const priceCents = Math.max(0, Math.round((Number(item.unitPrice) || 0) * 100));
      subtotalCents += qty * priceCents;
    }
    const taxCents = Math.max(0, Math.round((Number(invTax) || 0) * 100));
    const discountCents = Math.max(0, Math.round((Number(invDiscount) || 0) * 100));
    const totalCents = subtotalCents + taxCents - discountCents;

    const selectedCust = customerMap.get(invCustomerId);
    const currency = selectedCust?.currency || 'USD';

    return {
      currency,
      subtotal: subtotalCents / 100,
      tax: taxCents / 100,
      discount: discountCents / 100,
      total: totalCents / 100,
      isValidTotal: totalCents >= 0,
    };
  }, [invItems, invTax, invDiscount, invCustomerId, customerMap]);

  // Submit Create Invoice
  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!authToken) return;
    setInvSubmitting(true);
    setInvFormError(null);

    try {
      const parsedItems = invItems.map((item) => ({
        description: item.description.trim(),
        quantity: Number(item.quantity),
        unitPrice: Number(item.unitPrice),
      }));

      const dueDateIso = invDueDate
        ? new Date(`${invDueDate}T23:59:59.000Z`).toISOString()
        : undefined;

      const res = await fetch('/api/v1/invoices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          customerId: invCustomerId,
          status: invStatus,
          tax: Number(invTax) || 0,
          discount: Number(invDiscount) || 0,
          dueDate: dueDateIso,
          notes: invNotes.trim() ? invNotes.trim() : null,
          items: parsedItems,
        }),
      });

      const json: ApiResponse<Invoice> = await res.json();
      if (!res.ok || json.status === 'error') {
        const msg =
          json.error?.fields?.map((f) => `${f.field}: ${f.message}`).join(', ') ||
          json.error?.message ||
          'Failed to issue invoice';
        setInvFormError(msg);
        return;
      }

      setShowCreateInvoiceModal(false);
      await loadWorkspaceData(authToken);
      if (json.data) {
        setSelectedInvoice(json.data);
      }
    } catch (err: any) {
      setInvFormError(err.message || 'Network error while creating invoice');
    } finally {
      setInvSubmitting(false);
    }
  };

  // Update Invoice Status (PATCH /api/v1/invoices/:id)
  const handleUpdateInvoiceStatus = async (invoice: Invoice, nextStatus: InvoiceStatus) => {
    if (!authToken) return;
    setInvoiceActionLoading(true);
    setInvoiceActionError(null);

    try {
      const res = await fetch(`/api/v1/invoices/${invoice.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({ status: nextStatus }),
      });

      const json: ApiResponse<Invoice> = await res.json();
      if (!res.ok || json.status === 'error') {
        setInvoiceActionError(json.error?.message || 'Could not update invoice status');
        return;
      }

      if (json.data) {
        setSelectedInvoice(json.data);
      }
      await loadWorkspaceData(authToken);
    } catch (err: any) {
      setInvoiceActionError(err.message || 'Network error');
    } finally {
      setInvoiceActionLoading(false);
    }
  };

  // Delete Invoice (Admin Only)
  const handleDeleteInvoice = async (invoice: Invoice) => {
    if (!authToken) return;
    setInvoiceActionLoading(true);
    setInvoiceActionError(null);

    try {
      const res = await fetch(`/api/v1/invoices/${invoice.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      });

      if (res.status === 204 || res.ok) {
        setSelectedInvoice(null);
        await loadWorkspaceData(authToken);
        return;
      }

      const json: ApiResponse = await res.json();
      setInvoiceActionError(json.error?.message || 'Failed to delete invoice');
    } catch (err: any) {
      setInvoiceActionError(err.message || 'Network error');
    } finally {
      setInvoiceActionLoading(false);
    }
  };

  // Dashboard Summary Metrics
  const ledgerMetrics = useMemo(() => {
    let totalBilled = 0;
    let totalPaid = 0;
    let totalOutstanding = 0;
    let paidCount = 0;
    let openCount = 0;

    for (const inv of invoices) {
      if (inv.status === 'cancelled') continue;
      totalBilled += inv.total;
      if (inv.status === 'paid') {
        totalPaid += inv.total;
        paidCount += 1;
      } else if (inv.status === 'issued' || inv.status === 'overdue') {
        totalOutstanding += inv.total;
        openCount += 1;
      }
    }

    const primaryCurrency = customers[0]?.currency || invoices[0]?.currency || 'USD';

    return {
      totalBilled,
      totalPaid,
      totalOutstanding,
      paidCount,
      openCount,
      primaryCurrency,
    };
  }, [invoices, customers]);

  // Filtered & Sorted Invoices
  const filteredInvoices = useMemo(() => {
    const q = invoiceSearch.trim().toLowerCase();
    const list = invoices.filter((inv) => {
      const cust = customerMap.get(inv.customerId);
      const matchesQuery =
        !q ||
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.id.toLowerCase().includes(q) ||
        (cust?.name && cust.name.toLowerCase().includes(q)) ||
        (cust?.email && cust.email.toLowerCase().includes(q)) ||
        (inv.notes && inv.notes.toLowerCase().includes(q));
      const matchesStatus = invoiceStatusFilter === 'ALL' || inv.status === invoiceStatusFilter;
      const matchesCustomer =
        invoiceCustomerFilter === 'ALL' || inv.customerId === invoiceCustomerFilter;
      return matchesQuery && matchesStatus && matchesCustomer;
    });

    return [...list].sort((a, b) => {
      if (invoiceSort === 'amount') return b.total - a.total;
      if (invoiceSort === 'due') {
        return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime();
      }
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
  }, [invoices, customerMap, invoiceSearch, invoiceStatusFilter, invoiceCustomerFilter, invoiceSort]);

  // Filtered Customers
  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    return customers.filter((c) => {
      const matchesQuery =
        !q ||
        c.name.toLowerCase().includes(q) ||
        c.email.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q);
      const matchesCurrency =
        customerCurrencyFilter === 'ALL' || c.currency === customerCurrencyFilter;
      return matchesQuery && matchesCurrency;
    });
  }, [customers, customerSearch, customerCurrencyFilter]);

  const availableCurrencies = useMemo(() => {
    return Array.from(new Set(customers.map((c) => c.currency)));
  }, [customers]);

  // If unauthenticated, render clean Sign In / Register & 1-Tap Demo Workspace Gate
  if (!authToken) {
    return (
      <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col justify-between">
        {/* Top Bar Contract: 3 zones */}
        <header className="border-b border-slate-200 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
            <a href="/" className="text-lg font-bold tracking-tight text-slate-900">
              G7 Billing
            </a>
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
              <button
                type="button"
                onClick={() => setAuthMode('login')}
                className="hover:text-slate-900 transition-colors whitespace-nowrap"
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => setAuthMode('register')}
                className="hover:text-slate-900 transition-colors whitespace-nowrap"
              >
                Create Account
              </button>
              <button
                type="button"
                onClick={() => setShowLicenseModal(true)}
                className="hover:text-slate-900 transition-colors whitespace-nowrap"
              >
                MIT License
              </button>
            </nav>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}
                className="min-h-[40px] px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors whitespace-nowrap"
              >
                {authMode === 'login' ? 'Create Account' : 'Sign In'}
              </button>
            </div>
          </div>
        </header>

        {/* Main Authentication & Onboarding Canvas */}
        <main className="flex-1 flex items-center justify-center px-4 py-10 sm:py-16">
          <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-12 items-center">
            {/* Left Editorial Overview */}
            <div className="lg:col-span-7 space-y-6">
              <p className="text-xs font-semibold text-blue-700 tracking-normal">
                Financial Ledger & Multi-Item Invoicing
              </p>
              <h1
                className="text-2xl sm:text-4xl font-bold tracking-tight text-slate-900 leading-tight"
                style={{ textWrap: 'balance' }}
              >
                Manage customer accounts, billing ledgers, and invoices in one unified workspace.
              </h1>
              <p className="text-sm sm:text-base text-slate-600 leading-relaxed max-w-xl">
                Designed for phones, tablets, laptops, and desktop workstations. Issue itemized
                invoices with automatic integer-cents tax and discount calculation, track payment
                statuses in real time, and maintain clean multi-currency customer records.
              </p>

              <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <button
                  type="button"
                  onClick={() => setAuthMode('register')}
                  className="min-h-[48px] px-5 py-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm transition-colors flex items-center justify-center gap-2 whitespace-nowrap"
                >
                  <span>Create Account</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setShowLicenseModal(true)}
                  className="min-h-[48px] px-5 py-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-slate-700 font-medium text-sm transition-colors whitespace-nowrap"
                >
                  View MIT License
                </button>
              </div>

              <div className="pt-4 border-t border-slate-200 grid grid-cols-3 gap-4 text-left">
                <div>
                  <div className="text-lg sm:text-xl font-bold text-slate-900 font-mono tabular-nums">
                    100%
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">Exact Cents Arithmetic</div>
                </div>
                <div>
                  <div className="text-lg sm:text-xl font-bold text-slate-900 font-mono tabular-nums">
                    ISO 4217
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">Multi-Currency Ledgers</div>
                </div>
                <div>
                  <div className="text-lg sm:text-xl font-bold text-slate-900 font-mono tabular-nums">
                    ACID
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">PostgreSQL Persistence</div>
                </div>
              </div>
            </div>

            {/* Right Sign In / Register Panel */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-2xl p-6 sm:p-8">
              <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg mb-6">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('login');
                    setAuthError(null);
                    setAuthNotice(null);
                  }}
                  className={`flex-1 min-h-[40px] px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    authMode === 'login'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Sign In
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode('register');
                    setAuthError(null);
                    setAuthNotice(null);
                  }}
                  className={`flex-1 min-h-[40px] px-3 py-2 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                    authMode === 'register'
                      ? 'bg-white text-slate-900 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Create Account
                </button>
              </div>

              <h2 className="text-lg font-bold text-slate-900 mb-1">
                {authMode === 'login' ? 'Sign in to your account' : 'Create an operator account'}
              </h2>
              <p className="text-xs text-slate-500 mb-5">
                {authMode === 'login'
                  ? 'Enter your email and password to access your billing dashboard.'
                  : 'Register with a valid email and an 8+ character password.'}
              </p>

              {authNotice && (
                <div className="mb-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-start gap-2">
                  <Check className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>{authNotice}</span>
                </div>
              )}

              {authError && (
                <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                  <span>{authError}</span>
                </div>
              )}

              <form onSubmit={handleAuthSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Email Address
                  </label>
                  <input
                    type="email"
                    required
                    value={authEmail}
                    onChange={(e) => setAuthEmail(e.target.value)}
                    placeholder="you@company.com"
                    className="w-full min-h-[44px] px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                    Password
                  </label>
                  <input
                    type="password"
                    required
                    minLength={authMode === 'register' ? 8 : 1}
                    value={authPassword}
                    onChange={(e) => setAuthPassword(e.target.value)}
                    placeholder="Minimum 8 characters"
                    className="w-full min-h-[44px] px-3.5 py-2.5 rounded-lg border border-slate-300 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                  />
                </div>

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="w-full min-h-[46px] px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-sm font-semibold transition-colors disabled:opacity-50"
                >
                  {authSubmitting
                    ? 'Please wait...'
                    : authMode === 'login'
                    ? 'Sign In to Dashboard'
                    : 'Register & Sign In'}
                </button>
              </form>
            </div>
          </div>
        </main>

        {/* Quiet Footer */}
        <footer className="border-t border-slate-200 bg-white py-4 px-4 sm:px-6 lg:px-8">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
            <div>Copyright (c) 2026 [G7 COMMUNITY] · All rights reserved.</div>
            <button
              type="button"
              onClick={() => setShowLicenseModal(true)}
              className="hover:text-slate-900 underline underline-offset-4 transition-colors"
            >
              MIT License
            </button>
          </div>
        </footer>

        {showLicenseModal && (
          <LicenseModal onClose={() => setShowLicenseModal(false)} />
        )}
      </div>
    );
  }

  // Authenticated Single-UI Billing Dashboard (Responsive across Android Phone, Tablet, Laptop, Desktop PC)
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col lg:grid lg:grid-cols-[248px_1fr]">
      {/* Desktop / Laptop Left Sidebar Navigation (lg and up) */}
      <aside className="hidden lg:flex lg:flex-col lg:justify-between border-r border-slate-200 bg-white select-none">
        <div className="p-5 space-y-6">
          <div className="flex items-center justify-between">
            <span className="text-lg font-bold tracking-tight text-slate-900">
              G7 Billing
            </span>
          </div>

          <button
            type="button"
            onClick={() => openCreateInvoice()}
            className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>New Invoice</span>
          </button>

          <nav className="space-y-1">
            <button
              type="button"
              onClick={() => setActiveSection('overview')}
              className={`w-full min-h-[42px] px-3.5 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-between transition-colors ${
                activeSection === 'overview'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <LayoutDashboard className="w-4 h-4" />
                <span>Overview</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('invoices')}
              className={`w-full min-h-[42px] px-3.5 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-between transition-colors ${
                activeSection === 'invoices'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <FileText className="w-4 h-4" />
                <span>Invoices</span>
              </span>
              <span className="font-mono tabular-nums text-[11px] opacity-80">
                {invoices.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveSection('customers')}
              className={`w-full min-h-[42px] px-3.5 py-2.5 rounded-lg text-xs font-semibold flex items-center justify-between transition-colors ${
                activeSection === 'customers'
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Users className="w-4 h-4" />
                <span>Customers</span>
              </span>
              <span className="font-mono tabular-nums text-[11px] opacity-80">
                {customers.length}
              </span>
            </button>
          </nav>
        </div>

        {/* Bottom Account & License Zone */}
        <div className="p-5 border-t border-slate-200 space-y-4">
          {currentAccount && (
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-900 truncate" title={currentAccount.email}>
                {currentAccount.email}
              </div>
              <div className="text-[11px] text-slate-500">
                Role: <span className="font-medium text-slate-700">{currentAccount.role}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setShowLicenseModal(true)}
              className="text-xs text-slate-500 hover:text-slate-900 transition-colors"
            >
              MIT License
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="min-h-[36px] px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:text-red-600 hover:bg-red-50 flex items-center gap-1.5 transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Viewport */}
      <div className="flex-1 flex flex-col min-w-0 pb-20 lg:pb-0">
        {/* Top Bar Contract (3 Zones: Brand/Context Title — Nav Links — Primary Actions) */}
        <header className="border-b border-slate-200 bg-white">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-3">
            {/* Zone 1: Single text element wordmark / section title */}
            <a href="#top" className="text-base sm:text-lg font-bold tracking-tight text-slate-900 truncate">
              G7 Billing
            </a>

            {/* Zone 2: Clean text navigation links (visible on Tablet/Desktop) */}
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600">
              <button
                type="button"
                onClick={() => setActiveSection('overview')}
                className={`py-1 transition-colors whitespace-nowrap ${
                  activeSection === 'overview'
                    ? 'text-slate-900 font-semibold underline underline-offset-8 decoration-2 decoration-blue-600'
                    : 'hover:text-slate-900'
                }`}
              >
                Overview
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('invoices')}
                className={`py-1 transition-colors whitespace-nowrap ${
                  activeSection === 'invoices'
                    ? 'text-slate-900 font-semibold underline underline-offset-8 decoration-2 decoration-blue-600'
                    : 'hover:text-slate-900'
                }`}
              >
                Invoices ({invoices.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveSection('customers')}
                className={`py-1 transition-colors whitespace-nowrap ${
                  activeSection === 'customers'
                    ? 'text-slate-900 font-semibold underline underline-offset-8 decoration-2 decoration-blue-600'
                    : 'hover:text-slate-900'
                }`}
              >
                Customers ({customers.length})
              </button>
              <button
                type="button"
                onClick={() => setShowLicenseModal(true)}
                className="py-1 hover:text-slate-900 transition-colors whitespace-nowrap"
              >
                MIT License
              </button>
            </nav>

            {/* Zone 3: 1-2 Primary Actions */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={ openCreateCustomerModal }
                className="min-h-[40px] px-3 sm:px-4 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-xs font-semibold transition-colors whitespace-nowrap"
              >
                + Customer
              </button>
              <button
                type="button"
                onClick={() => openCreateInvoice()}
                className="min-h-[40px] px-3.5 sm:px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                + New Invoice
              </button>
              <button
                type="button"
                onClick={handleLogout}
                title="Sign Out"
                className="lg:hidden min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:text-red-600"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </header>

        {/* Workspace Body */}
        <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-8">
          {bannerError && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700 flex items-center justify-between gap-3">
              <span>{bannerError}</span>
              <button
                type="button"
                onClick={() => loadWorkspaceData(authToken)}
                className="px-3 py-1.5 rounded-lg bg-white border border-red-200 text-xs font-semibold text-red-700 hover:bg-red-100 whitespace-nowrap"
              >
                Retry
              </button>
            </div>
          )}

          {/* KPI Summary Strip (Shared across Overview and Invoices) */}
          <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6 divide-y sm:divide-y-0 sm:divide-x divide-slate-100">
              <div className="pt-2 sm:pt-0 sm:px-4 first:pl-0 first:pt-0">
                <div className="text-xs text-slate-500">Total Billed Volume</div>
                <div className="text-lg sm:text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                  {formatMoney(ledgerMetrics.totalBilled, ledgerMetrics.primaryCurrency)}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {invoices.length} total invoices
                </div>
              </div>

              <div className="pt-2 sm:pt-0 sm:px-4">
                <div className="text-xs text-slate-500">Collected Revenue</div>
                <div className="text-lg sm:text-2xl font-bold text-emerald-700 font-mono tabular-nums mt-1">
                  {formatMoney(ledgerMetrics.totalPaid, ledgerMetrics.primaryCurrency)}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {ledgerMetrics.paidCount} paid in full
                </div>
              </div>

              <div className="pt-3 sm:pt-0 sm:px-4">
                <div className="text-xs text-slate-500">Outstanding Balance</div>
                <div className="text-lg sm:text-2xl font-bold text-blue-700 font-mono tabular-nums mt-1">
                  {formatMoney(ledgerMetrics.totalOutstanding, ledgerMetrics.primaryCurrency)}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {ledgerMetrics.openCount} awaiting payment
                </div>
              </div>

              <div className="pt-3 sm:pt-0 sm:px-4">
                <div className="text-xs text-slate-500">Active Customers</div>
                <div className="text-lg sm:text-2xl font-bold text-slate-900 font-mono tabular-nums mt-1">
                  {customers.length}
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  {availableCurrencies.length > 0
                    ? `Currencies: ${availableCurrencies.join(' · ')}`
                    : 'No currencies active'}
                </div>
              </div>
            </div>
          </section>

          {/* Empty Workspace Onboarding Banner if no customers exist yet */}
          {!loadingData && customers.length === 0 && (
            <section className="bg-white border border-slate-200 rounded-2xl p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
              <div className="space-y-1.5 max-w-xl">
                <h2 className="text-base sm:text-lg font-bold text-slate-900">
                  Your billing ledger is ready
                </h2>
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
                  Add your first customer record in the backend database to begin issuing and tracking
                  multi-item invoices.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 w-full sm:w-auto">
                <button
                  type="button"
                  onClick={openCreateCustomerModal}
                  className="flex-1 sm:flex-initial min-h-[44px] px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors whitespace-nowrap"
                >
                  + Create First Customer
                </button>
              </div>
            </section>
          )}

          {/* SECTION 1: OVERVIEW (Unified Split View on Desktop/PC, Stacked on Mobile/Tablet) */}
          {activeSection === 'overview' && (
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">
              {/* Left 7 Columns: Recent Invoices */}
              <section className="xl:col-span-7 bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">Recent Invoices</h2>
                    <p className="text-xs text-slate-500">
                      Click any invoice to inspect line items or update payment status
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => loadWorkspaceData(authToken)}
                      title="Refresh Ledger"
                      className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-50 transition-colors"
                    >
                      <RefreshCw className={`w-4 h-4 ${loadingData ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveSection('invoices')}
                      className="min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-700 hover:bg-blue-50 transition-colors whitespace-nowrap"
                    >
                      View All ({invoices.length})
                    </button>
                  </div>
                </div>

                {invoices.length === 0 ? (
                  <div className="p-8 text-center space-y-3">
                    <p className="text-sm font-medium text-slate-700">No invoices issued yet</p>
                    <p className="text-xs text-slate-500 max-w-sm mx-auto">
                      Issue a multi-item invoice for any customer to calculate totals automatically.
                    </p>
                    <button
                      type="button"
                      onClick={() => openCreateInvoice()}
                      className="min-h-[44px] px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors"
                    >
                      + Issue First Invoice
                    </button>
                  </div>
                ) : (
                  <>
                    {/* Desktop / Tablet Landscape Table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/60">
                            <th className="py-3 px-4">Invoice</th>
                            <th className="py-3 px-4">Customer</th>
                            <th className="py-3 px-4">Status · Due</th>
                            <th className="py-3 px-4 text-right">Total</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-xs">
                          {invoices.slice(0, 8).map((inv) => {
                            const cust = customerMap.get(inv.customerId);
                            return (
                              <tr
                                key={inv.id}
                                onClick={() => {
                                  setInvoiceActionError(null);
                                  setSelectedInvoice(inv);
                                }}
                                className="hover:bg-slate-50 cursor-pointer transition-colors"
                              >
                                <td className="py-3.5 px-4 font-mono tabular-nums font-semibold text-slate-900">
                                  {inv.invoiceNumber}
                                </td>
                                <td className="py-3.5 px-4">
                                  <div className="font-medium text-slate-900 truncate max-w-[180px]">
                                    {cust?.name || inv.customerId}
                                  </div>
                                  <div className="text-[11px] text-slate-500">
                                    {inv.items.length} {inv.items.length === 1 ? 'item' : 'items'} · {inv.currency}
                                  </div>
                                </td>
                                <td className="py-3.5 px-4">
                                  <span className={getStatusColorClass(inv.status)}>
                                    {getStatusLabel(inv.status)}
                                  </span>
                                  <span className="text-slate-400 mx-1.5">·</span>
                                  <span className="text-slate-500 font-mono tabular-nums">
                                    {formatDateShort(inv.dueDate)}
                                  </span>
                                </td>
                                <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                                  {formatMoney(inv.total, inv.currency)}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    {/* Mobile / Android Touch Rows */}
                    <div className="md:hidden divide-y divide-slate-100">
                      {invoices.slice(0, 8).map((inv) => {
                        const cust = customerMap.get(inv.customerId);
                        return (
                          <button
                            key={inv.id}
                            type="button"
                            onClick={() => {
                              setInvoiceActionError(null);
                              setSelectedInvoice(inv);
                            }}
                            className="w-full min-h-[64px] p-4 text-left hover:bg-slate-50 flex items-center justify-between gap-3 transition-colors"
                          >
                            <div className="min-w-0 space-y-1">
                              <div className="flex items-center gap-2 text-xs">
                                <span className="font-mono tabular-nums font-bold text-slate-900">
                                  {inv.invoiceNumber}
                                </span>
                                <span className="text-slate-400">·</span>
                                <span className={getStatusColorClass(inv.status)}>
                                  {getStatusLabel(inv.status)}
                                </span>
                              </div>
                              <div className="text-xs font-medium text-slate-700 truncate">
                                {cust?.name || inv.customerId}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                                Due {formatDateShort(inv.dueDate)} · {inv.items.length}{' '}
                                {inv.items.length === 1 ? 'item' : 'items'}
                              </div>
                            </div>
                            <div className="text-right shrink-0 flex items-center gap-2">
                              <div>
                                <div className="text-sm font-bold text-slate-900 font-mono tabular-nums">
                                  {formatMoney(inv.total, inv.currency)}
                                </div>
                                <div className="text-[11px] text-slate-500 font-mono">
                                  {inv.currency}
                                </div>
                              </div>
                              <ChevronRight className="w-4 h-4 text-slate-400" />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>

              {/* Right 5 Columns: Customer Accounts Directory */}
              <section className="xl:col-span-5 bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">Customer Directory</h2>
                    <p className="text-xs text-slate-500">
                      Billed entities and default ledger currencies
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openCreateCustomerModal}
                      className="min-h-[40px] px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold transition-colors whitespace-nowrap"
                    >
                      + Add
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveSection('customers')}
                      className="min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold text-blue-700 hover:bg-blue-50 transition-colors whitespace-nowrap"
                    >
                      Manage ({customers.length})
                    </button>
                  </div>
                </div>

                {customers.length === 0 ? (
                  <div className="p-8 text-center space-y-3">
                    <p className="text-sm font-medium text-slate-700">No customers registered</p>
                    <p className="text-xs text-slate-500">
                      Create a customer record to start tracking invoices by currency.
                    </p>
                    <button
                      type="button"
                      onClick={openCreateCustomerModal}
                      className="min-h-[44px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors"
                    >
                      + New Customer
                    </button>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {customers.slice(0, 8).map((c) => {
                      const custInvoices = invoices.filter((i) => i.customerId === c.id);
                      const custTotal = custInvoices
                        .filter((i) => i.status !== 'cancelled')
                        .reduce((acc, i) => acc + i.total, 0);

                      return (
                        <div
                          key={c.id}
                          className="p-4 hover:bg-slate-50 flex items-center justify-between gap-3 transition-colors"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="text-xs sm:text-sm font-semibold text-slate-900 truncate">
                              {c.name}
                            </div>
                            <div className="text-xs text-slate-500 truncate">{c.email}</div>
                            <div className="text-[11px] text-slate-500 font-mono tabular-nums">
                              {c.currency} · {custInvoices.length}{' '}
                              {custInvoices.length === 1 ? 'invoice' : 'invoices'} ·{' '}
                              {formatMoney(custTotal, c.currency)}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={() => openCreateInvoice(c.id)}
                              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-700 transition-colors whitespace-nowrap"
                            >
                              + Invoice
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditCustomerModal(c)}
                              title="Edit Customer"
                              className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* SECTION 2: FULL INVOICES LEDGER */}
          {activeSection === 'invoices' && (
            <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="p-4 sm:p-6 border-b border-slate-200 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-lg font-bold text-slate-900">Invoices Ledger</h1>
                    <p className="text-xs text-slate-500">
                      Filter by lifecycle status, search line items, or issue new customer invoices
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openCreateInvoice()}
                      className="min-h-[44px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Issue Invoice</span>
                    </button>
                  </div>
                </div>

                {/* Search + Segmented Status Filter Controls */}
                <div className="flex flex-col lg:flex-row items-stretch lg:items-center justify-between gap-3">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={invoiceSearch}
                      onChange={(e) => setInvoiceSearch(e.target.value)}
                      placeholder="Search by invoice number, customer name, or notes..."
                      className="w-full min-h-[42px] pl-10 pr-4 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  {/* Interactive Filter Buttons */}
                  <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                    {(['ALL', 'issued', 'paid', 'draft', 'overdue', 'cancelled'] as const).map(
                      (status) => (
                        <button
                          key={status}
                          type="button"
                          onClick={() => setInvoiceStatusFilter(status)}
                          className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
                            invoiceStatusFilter === status
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {status === 'ALL' ? 'All Statuses' : getStatusLabel(status)}
                        </button>
                      )
                    )}
                  </div>

                  {/* Sort Control */}
                  <div className="flex items-center gap-2">
                    <ArrowUpDown className="w-4 h-4 text-slate-400 shrink-0 hidden sm:block" />
                    <select
                      value={invoiceSort}
                      onChange={(e) => setInvoiceSort(e.target.value as any)}
                      className="min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    >
                      <option value="newest">Sort: Newest First</option>
                      <option value="due">Sort: Due Date</option>
                      <option value="amount">Sort: Highest Amount</option>
                    </select>
                  </div>
                </div>
              </div>

              {filteredInvoices.length === 0 ? (
                <div className="p-12 text-center space-y-3">
                  <p className="text-sm font-semibold text-slate-800">
                    No matching invoices found
                  </p>
                  <p className="text-xs text-slate-500 max-w-md mx-auto">
                    Try clearing your search filter or issue a new multi-item invoice.
                  </p>
                </div>
              ) : (
                <>
                  {/* Desktop / Laptop / Tablet-Landscape Table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                          <th className="py-3.5 px-5">Invoice Number</th>
                          <th className="py-3.5 px-5">Customer</th>
                          <th className="py-3.5 px-5">Status</th>
                          <th className="py-3.5 px-5">Issued · Due</th>
                          <th className="py-3.5 px-5 text-right">Subtotal</th>
                          <th className="py-3.5 px-5 text-right">Tax / Disc</th>
                          <th className="py-3.5 px-5 text-right">Total</th>
                          <th className="py-3.5 px-5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {filteredInvoices.map((inv) => {
                          const cust = customerMap.get(inv.customerId);
                          return (
                            <tr
                              key={inv.id}
                              onClick={() => {
                                setInvoiceActionError(null);
                                setSelectedInvoice(inv);
                              }}
                              className="hover:bg-slate-50 cursor-pointer transition-colors"
                            >
                              <td className="py-4 px-5 font-mono tabular-nums font-bold text-slate-900 whitespace-nowrap">
                                {inv.invoiceNumber}
                              </td>
                              <td className="py-4 px-5">
                                <div className="font-semibold text-slate-900">
                                  {cust?.name || inv.customerId}
                                </div>
                                <div className="text-[11px] text-slate-500">
                                  {cust?.email || inv.id}
                                </div>
                              </td>
                              <td className="py-4 px-5 whitespace-nowrap">
                                <span className={getStatusColorClass(inv.status)}>
                                  {getStatusLabel(inv.status)}
                                </span>
                              </td>
                              <td className="py-4 px-5 font-mono tabular-nums text-slate-600 whitespace-nowrap">
                                {formatDateShort(inv.issueDate)} · {formatDateShort(inv.dueDate)}
                              </td>
                              <td className="py-4 px-5 text-right font-mono tabular-nums text-slate-600 whitespace-nowrap">
                                {formatMoney(inv.subtotal, inv.currency)}
                              </td>
                              <td className="py-4 px-5 text-right font-mono tabular-nums text-slate-500 whitespace-nowrap">
                                +{formatMoney(inv.tax, inv.currency)} / -{formatMoney(inv.discount, inv.currency)}
                              </td>
                              <td className="py-4 px-5 text-right font-mono tabular-nums font-bold text-slate-900 whitespace-nowrap">
                                {formatMoney(inv.total, inv.currency)}
                              </td>
                              <td
                                className="py-4 px-5 text-right whitespace-nowrap"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setInvoiceActionError(null);
                                    setSelectedInvoice(inv);
                                  }}
                                  className="min-h-[36px] px-3 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-xs font-semibold text-slate-700 transition-colors"
                                >
                                  Inspect
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile / Android Touch Cards */}
                  <div className="md:hidden divide-y divide-slate-100">
                    {filteredInvoices.map((inv) => {
                      const cust = customerMap.get(inv.customerId);
                      return (
                        <button
                          key={inv.id}
                          type="button"
                          onClick={() => {
                            setInvoiceActionError(null);
                            setSelectedInvoice(inv);
                          }}
                          className="w-full p-4 text-left hover:bg-slate-50 flex items-center justify-between gap-3 transition-colors"
                        >
                          <div className="min-w-0 space-y-1">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="font-mono tabular-nums font-bold text-slate-900">
                                {inv.invoiceNumber}
                              </span>
                              <span className="text-slate-400">·</span>
                              <span className={getStatusColorClass(inv.status)}>
                                {getStatusLabel(inv.status)}
                              </span>
                            </div>
                            <div className="text-sm font-semibold text-slate-900 truncate">
                              {cust?.name || inv.customerId}
                            </div>
                            <div className="text-xs text-slate-500 font-mono tabular-nums">
                              Due {formatDateShort(inv.dueDate)} · {inv.items.length} line{' '}
                              {inv.items.length === 1 ? 'item' : 'items'}
                            </div>
                          </div>
                          <div className="text-right shrink-0 flex items-center gap-2">
                            <div>
                              <div className="text-sm font-bold text-slate-900 font-mono tabular-nums">
                                {formatMoney(inv.total, inv.currency)}
                              </div>
                              <div className="text-[11px] text-slate-500 font-mono">
                                {inv.currency}
                              </div>
                            </div>
                            <ChevronRight className="w-4 h-4 text-slate-400" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          )}

          {/* SECTION 3: FULL CUSTOMERS DIRECTORY */}
          {activeSection === 'customers' && (
            <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
              <div className="p-4 sm:p-6 border-b border-slate-200 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-lg font-bold text-slate-900">Customers Ledger</h1>
                    <p className="text-xs text-slate-500">
                      Manage customer billing profiles, ISO currencies, and account invoices
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={openCreateCustomerModal}
                      className="min-h-[44px] px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-2 transition-colors whitespace-nowrap"
                    >
                      <Plus className="w-4 h-4" />
                      <span>New Customer</span>
                    </button>
                  </div>
                </div>

                {/* Search & Currency Filter */}
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      placeholder="Search customers by name, email, or ID..."
                      className="w-full min-h-[42px] pl-10 pr-4 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                  </div>

                  {availableCurrencies.length > 0 && (
                    <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg overflow-x-auto">
                      <button
                        type="button"
                        onClick={() => setCustomerCurrencyFilter('ALL')}
                        className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                          customerCurrencyFilter === 'ALL'
                            ? 'bg-white text-slate-900 shadow-xs'
                            : 'text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        All Currencies
                      </button>
                      {availableCurrencies.map((curr) => (
                        <button
                          key={curr}
                          type="button"
                          onClick={() => setCustomerCurrencyFilter(curr)}
                          className={`min-h-[36px] px-3 py-1.5 text-xs font-mono font-semibold rounded-md transition-colors whitespace-nowrap ${
                            customerCurrencyFilter === curr
                              ? 'bg-white text-slate-900 shadow-xs'
                              : 'text-slate-600 hover:text-slate-900'
                          }`}
                        >
                          {curr}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {filteredCustomers.length === 0 ? (
                <div className="p-12 text-center space-y-3">
                  <p className="text-sm font-semibold text-slate-800">
                    No matching customer records
                  </p>
                  <p className="text-xs text-slate-500 max-w-sm mx-auto">
                    Add a customer with a 3-letter ISO currency code to start billing.
                  </p>
                </div>
              ) : (
                <>
                  {/* Desktop / Tablet Table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500 bg-slate-50/70">
                          <th className="py-3.5 px-5">Customer Name</th>
                          <th className="py-3.5 px-5">Email Address</th>
                          <th className="py-3.5 px-5">Currency</th>
                          <th className="py-3.5 px-5 text-right">Invoices</th>
                          <th className="py-3.5 px-5 text-right">Billed Total</th>
                          <th className="py-3.5 px-5 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-xs">
                        {filteredCustomers.map((c) => {
                          const custInvoices = invoices.filter((i) => i.customerId === c.id);
                          const custBilled = custInvoices
                            .filter((i) => i.status !== 'cancelled')
                            .reduce((sum, i) => sum + i.total, 0);

                          return (
                            <tr key={c.id} className="hover:bg-slate-50 transition-colors">
                              <td className="py-4 px-5">
                                <div className="font-semibold text-slate-900">{c.name}</div>
                                <div className="text-[11px] font-mono text-slate-400">{c.id}</div>
                              </td>
                              <td className="py-4 px-5 text-slate-700">{c.email}</td>
                              <td className="py-4 px-5 font-mono font-semibold text-slate-900">
                                {c.currency}
                              </td>
                              <td className="py-4 px-5 text-right font-mono tabular-nums text-slate-700">
                                {custInvoices.length}
                              </td>
                              <td className="py-4 px-5 text-right font-mono tabular-nums font-semibold text-slate-900">
                                {formatMoney(custBilled, c.currency)}
                              </td>
                              <td className="py-4 px-5 text-right whitespace-nowrap">
                                <div className="inline-flex items-center gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => openCreateInvoice(c.id)}
                                    className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold transition-colors"
                                  >
                                    + Issue Invoice
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setInvoiceCustomerFilter(c.id);
                                      setActiveSection('invoices');
                                    }}
                                    className="min-h-[36px] px-2.5 py-1.5 rounded-lg border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700 transition-colors"
                                  >
                                    Invoices
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openEditCustomerModal(c)}
                                    title="Edit Customer"
                                    className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
                                  >
                                    <Edit3 className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setDeleteCustomerError(null);
                                      setDeletingCustomer(c);
                                    }}
                                    title="Delete Customer"
                                    className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-red-600 hover:bg-red-50 transition-colors"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile / Android Touch List */}
                  <div className="md:hidden divide-y divide-slate-100">
                    {filteredCustomers.map((c) => {
                      const custInvoices = invoices.filter((i) => i.customerId === c.id);
                      const custBilled = custInvoices
                        .filter((i) => i.status !== 'cancelled')
                        .reduce((sum, i) => sum + i.total, 0);

                      return (
                        <div key={c.id} className="p-4 space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-bold text-slate-900 truncate">
                                {c.name}
                              </div>
                              <div className="text-xs text-slate-500 truncate">{c.email}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-sm font-bold font-mono tabular-nums text-slate-900">
                                {formatMoney(custBilled, c.currency)}
                              </div>
                              <div className="text-[11px] font-mono text-slate-500">
                                {c.currency} · {custInvoices.length}{' '}
                                {custInvoices.length === 1 ? 'invoice' : 'invoices'}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => openCreateInvoice(c.id)}
                              className="flex-1 min-h-[42px] px-3 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold transition-colors"
                            >
                              + Issue Invoice
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditCustomerModal(c)}
                              className="min-h-[42px] px-3 py-2 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDeleteCustomerError(null);
                                setDeletingCustomer(c);
                              }}
                              className="min-h-[42px] min-w-[42px] flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-red-600"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </section>
          )}
        </main>

        {/* Quiet Desktop/Tablet Footer */}
        <footer className="border-t border-slate-200 bg-white py-4 px-4 sm:px-6 lg:px-8 mt-auto">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-slate-500">
            <div>Copyright (c) 2026 [G7 COMMUNITY] · MIT License</div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => setShowLicenseModal(true)}
                className="hover:text-slate-900 underline underline-offset-4 transition-colors"
              >
                View License
              </button>
            </div>
          </div>
        </footer>
      </div>

      {/* Mobile / Android Fixed Bottom Navigation Bar (< 1024px, < 8% viewport height) */}
      <nav
        aria-label="Mobile Navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-white/95 backdrop-blur-md border-t border-slate-200 grid grid-cols-4 items-center px-2"
      >
        <button
          type="button"
          onClick={() => setActiveSection('overview')}
          className={`min-h-[44px] flex flex-col items-center justify-center rounded-lg transition-colors ${
            activeSection === 'overview' ? 'text-blue-600 font-semibold' : 'text-slate-500'
          }`}
        >
          <LayoutDashboard className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Overview</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSection('invoices')}
          className={`min-h-[44px] flex flex-col items-center justify-center rounded-lg transition-colors ${
            activeSection === 'invoices' ? 'text-blue-600 font-semibold' : 'text-slate-500'
          }`}
        >
          <FileText className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Invoices</span>
        </button>

        <button
          type="button"
          onClick={() => setActiveSection('customers')}
          className={`min-h-[44px] flex flex-col items-center justify-center rounded-lg transition-colors ${
            activeSection === 'customers' ? 'text-blue-600 font-semibold' : 'text-slate-500'
          }`}
        >
          <Users className="w-5 h-5" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">Customers</span>
        </button>

        <button
          type="button"
          onClick={() => openCreateInvoice()}
          className="min-h-[44px] flex flex-col items-center justify-center rounded-lg text-slate-900 font-semibold"
        >
          <Plus className="w-5 h-5 text-blue-600" />
          <span className="text-[10px] mt-0.5 whitespace-nowrap">New Invoice</span>
        </button>
      </nav>

      {/* MODAL 1: Create / Edit Customer (Bottom Sheet on Android/Mobile, Dialog on Desktop) */}
      {customerModalMode && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-slate-200 p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                {customerModalMode === 'edit' ? 'Edit Customer Profile' : 'New Customer Account'}
              </h3>
              <button
                type="button"
                onClick={() => setCustomerModalMode(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {custFormError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {custFormError}
              </div>
            )}

            <form onSubmit={handleSaveCustomer} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Customer or Company Name
                </label>
                <input
                  type="text"
                  required
                  value={custName}
                  onChange={(e) => setCustName(e.target.value)}
                  placeholder="e.g. Acme Global Corp"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Billing Email Address
                </label>
                <input
                  type="email"
                  required
                  value={custEmail}
                  onChange={(e) => setCustEmail(e.target.value)}
                  placeholder="billing@company.com"
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                  Ledger Currency (ISO 4217)
                </label>
                <select
                  value={custCurrency}
                  onChange={(e) => setCustCurrency(e.target.value)}
                  className="w-full min-h-[44px] px-3.5 py-2 rounded-lg border border-slate-300 bg-white text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  {CURRENCY_OPTIONS.map((curr) => (
                    <option key={curr} value={curr}>
                      {curr}
                    </option>
                  ))}
                </select>
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setCustomerModalMode(null)}
                  className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={custSubmitting}
                  className="min-h-[44px] px-5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold disabled:opacity-50"
                >
                  {custSubmitting
                    ? 'Saving...'
                    : customerModalMode === 'edit'
                    ? 'Save Changes'
                    : 'Create Customer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Delete Customer Confirmation */}
      {deletingCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Delete Customer Record</h3>
              <button
                type="button"
                onClick={() => setDeletingCustomer(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              Are you sure you want to delete{' '}
              <span className="font-semibold text-slate-900">{deletingCustomer.name}</span>?
              Customers with existing invoices are protected by referential integrity constraints,
              and deletion requires administrative privileges.
            </p>

            {deleteCustomerError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {deleteCustomerError}
              </div>
            )}

            <div className="pt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingCustomer(null)}
                className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteCustomer}
                disabled={custSubmitting}
                className="min-h-[44px] px-5 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-50"
              >
                {custSubmitting ? 'Deleting...' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: Issue Multi-Item Invoice */}
      {showCreateInvoiceModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full sm:max-w-2xl rounded-t-3xl sm:rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-5 max-h-[92vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">Issue Multi-Item Invoice</h3>
                <p className="text-xs text-slate-500">
                  Line totals, subtotal, and final balance are computed in exact integer cents
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateInvoiceModal(false)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {invFormError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {invFormError}
              </div>
            )}

            <form onSubmit={handleCreateInvoice} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="sm:col-span-1">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Customer
                  </label>
                  <select
                    required
                    value={invCustomerId}
                    onChange={(e) => setInvCustomerId(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.currency})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Initial Status
                  </label>
                  <select
                    value={invStatus}
                    onChange={(e) => setInvStatus(e.target.value as InvoiceStatus)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 bg-white text-xs sm:text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  >
                    <option value="issued">Issued</option>
                    <option value="draft">Draft</option>
                    <option value="paid">Paid</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Due Date
                  </label>
                  <input
                    type="date"
                    required
                    value={invDueDate}
                    onChange={(e) => setInvDueDate(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-lg border border-slate-300 text-xs sm:text-sm font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>

              {/* Line Items Builder */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-700">
                    Invoice Line Items ({invItems.length})
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setInvItems((prev) => [
                        ...prev,
                        { description: '', quantity: '1', unitPrice: '50.00' },
                      ])
                    }
                    className="min-h-[36px] px-3 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-xs font-semibold text-slate-800 transition-colors"
                  >
                    + Add Line Item
                  </button>
                </div>

                <div className="space-y-2.5">
                  {invItems.map((item, idx) => {
                    const lineCents =
                      Math.max(0, Math.floor(Number(item.quantity) || 0)) *
                      Math.max(0, Math.round((Number(item.unitPrice) || 0) * 100));
                    return (
                      <div
                        key={idx}
                        className="grid grid-cols-1 sm:grid-cols-12 gap-2 p-3 rounded-xl border border-slate-200 bg-slate-50/60 items-center"
                      >
                        <div className="sm:col-span-6">
                          <input
                            type="text"
                            required
                            placeholder="Description of service or product"
                            value={item.description}
                            onChange={(e) => {
                              const val = e.target.value;
                              setInvItems((prev) =>
                                prev.map((it, i) => (i === idx ? { ...it, description: val } : it))
                              );
                            }}
                            className="w-full min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs text-slate-900"
                          />
                        </div>
                        <div className="grid grid-cols-3 sm:col-span-6 gap-2 items-center">
                          <div>
                            <input
                              type="number"
                              min={1}
                              max={1000000}
                              step={1}
                              required
                              placeholder="Qty"
                              value={item.quantity}
                              onChange={(e) => {
                                const val = e.target.value;
                                setInvItems((prev) =>
                                  prev.map((it, i) => (i === idx ? { ...it, quantity: val } : it))
                                );
                              }}
                              className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums text-slate-900"
                            />
                          </div>
                          <div>
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              required
                              placeholder="Unit Price"
                              value={item.unitPrice}
                              onChange={(e) => {
                                const val = e.target.value;
                                setInvItems((prev) =>
                                  prev.map((it, i) => (i === idx ? { ...it, unitPrice: val } : it))
                                );
                              }}
                              className="w-full min-h-[40px] px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-mono tabular-nums text-slate-900"
                            />
                          </div>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-mono tabular-nums font-semibold text-slate-800 truncate">
                              {formatMoney(lineCents / 100, draftFinancialPreview.currency)}
                            </span>
                            {invItems.length > 1 && (
                              <button
                                type="button"
                                onClick={() =>
                                  setInvItems((prev) => prev.filter((_, i) => i !== idx))
                                }
                                className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg text-slate-400 hover:text-red-600"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Tax, Discount & Notes */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tax ({draftFinancialPreview.currency})
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={invTax}
                    onChange={(e) => setInvTax(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono tabular-nums text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Discount ({draftFinancialPreview.currency})
                  </label>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={invDiscount}
                    onChange={(e) => setInvDiscount(e.target.value)}
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-xs font-mono tabular-nums text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Notes (Optional)
                  </label>
                  <input
                    type="text"
                    maxLength={1000}
                    value={invNotes}
                    onChange={(e) => setInvNotes(e.target.value)}
                    placeholder="Payment terms or PO reference"
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 text-xs text-slate-900"
                  />
                </div>
              </div>

              {/* Authoritative Summary Footer */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="text-xs text-slate-600 space-y-0.5 font-mono tabular-nums">
                  <div>
                    Subtotal:{' '}
                    {formatMoney(draftFinancialPreview.subtotal, draftFinancialPreview.currency)} ·
                    Tax: +{formatMoney(draftFinancialPreview.tax, draftFinancialPreview.currency)} ·
                    Discount: -
                    {formatMoney(draftFinancialPreview.discount, draftFinancialPreview.currency)}
                  </div>
                  <div className="text-sm font-bold text-slate-900">
                    Total Due:{' '}
                    {formatMoney(draftFinancialPreview.total, draftFinancialPreview.currency)}
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setShowCreateInvoiceModal(false)}
                    className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 bg-white text-xs font-semibold text-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={invSubmitting || !draftFinancialPreview.isValidTotal}
                    className="min-h-[44px] px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
                  >
                    {invSubmitting ? 'Issuing Invoice...' : 'Create Invoice'}
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 4: Invoice Detail & Lifecycle Inspector */}
      {selectedInvoice && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
          <div className="bg-white w-full sm:max-w-2xl rounded-t-3xl sm:rounded-2xl border border-slate-200 p-5 sm:p-6 space-y-5 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono tabular-nums font-bold text-slate-900">
                    {selectedInvoice.invoiceNumber}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className={getStatusColorClass(selectedInvoice.status)}>
                    {getStatusLabel(selectedInvoice.status)}
                  </span>
                </div>
                <h3 className="text-base sm:text-lg font-bold text-slate-900 mt-1">
                  {customerMap.get(selectedInvoice.customerId)?.name || selectedInvoice.customerId}
                </h3>
                <p className="text-xs text-slate-500 font-mono tabular-nums">
                  Issued {formatDateShort(selectedInvoice.issueDate)} · Due{' '}
                  {formatDateShort(selectedInvoice.dueDate)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedInvoice(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {invoiceActionError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {invoiceActionError}
              </div>
            )}

            {/* Line Items Table */}
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                    <th className="py-2.5 px-4">Description</th>
                    <th className="py-2.5 px-3 text-right">Qty</th>
                    <th className="py-2.5 px-3 text-right">Unit Price</th>
                    <th className="py-2.5 px-4 text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {selectedInvoice.items.map((item) => (
                    <tr key={item.id}>
                      <td className="py-3 px-4 font-medium text-slate-900">{item.description}</td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600">
                        {item.quantity}
                      </td>
                      <td className="py-3 px-3 text-right font-mono tabular-nums text-slate-600">
                        {formatMoney(item.unitPrice, selectedInvoice.currency)}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold text-slate-900">
                        {formatMoney(item.lineTotal, selectedInvoice.currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals Breakdown */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
              <div className="text-xs text-slate-600 max-w-xs">
                {selectedInvoice.notes ? (
                  <>
                    <span className="font-semibold text-slate-800">Notes: </span>
                    <span>{selectedInvoice.notes}</span>
                  </>
                ) : (
                  <span className="text-slate-400">No additional invoice notes</span>
                )}
              </div>

              <div className="space-y-1 text-xs font-mono tabular-nums text-right">
                <div className="text-slate-600">
                  Subtotal: {formatMoney(selectedInvoice.subtotal, selectedInvoice.currency)}
                </div>
                <div className="text-slate-600">
                  Tax: +{formatMoney(selectedInvoice.tax, selectedInvoice.currency)} · Discount: -
                  {formatMoney(selectedInvoice.discount, selectedInvoice.currency)}
                </div>
                <div className="text-base font-bold text-slate-900 pt-1 border-t border-slate-200">
                  Total: {formatMoney(selectedInvoice.total, selectedInvoice.currency)}
                </div>
              </div>
            </div>

            {/* Status Transition & Action Controls */}
            <div className="pt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {selectedInvoice.status !== 'paid' && (
                  <button
                    type="button"
                    disabled={invoiceActionLoading}
                    onClick={() => handleUpdateInvoiceStatus(selectedInvoice, 'paid')}
                    className="min-h-[42px] px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors disabled:opacity-50"
                  >
                    Mark as Paid
                  </button>
                )}
                {selectedInvoice.status === 'draft' && (
                  <button
                    type="button"
                    disabled={invoiceActionLoading}
                    onClick={() => handleUpdateInvoiceStatus(selectedInvoice, 'issued')}
                    className="min-h-[42px] px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors disabled:opacity-50"
                  >
                    Mark as Issued
                  </button>
                )}
                {selectedInvoice.status !== 'overdue' && selectedInvoice.status !== 'paid' && (
                  <button
                    type="button"
                    disabled={invoiceActionLoading}
                    onClick={() => handleUpdateInvoiceStatus(selectedInvoice, 'overdue')}
                    className="min-h-[42px] px-3.5 py-2 rounded-lg border border-slate-300 hover:bg-slate-100 text-xs font-semibold text-slate-700 transition-colors disabled:opacity-50"
                  >
                    Mark Overdue
                  </button>
                )}
                {selectedInvoice.status !== 'cancelled' && selectedInvoice.status !== 'paid' && (
                  <button
                    type="button"
                    disabled={invoiceActionLoading}
                    onClick={() => handleUpdateInvoiceStatus(selectedInvoice, 'cancelled')}
                    className="min-h-[42px] px-3.5 py-2 rounded-lg border border-slate-300 hover:bg-slate-100 text-xs font-semibold text-slate-600 transition-colors disabled:opacity-50"
                  >
                    Cancel Invoice
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={invoiceActionLoading}
                  onClick={() => handleDeleteInvoice(selectedInvoice)}
                  className="min-h-[42px] px-3.5 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-xs font-semibold transition-colors disabled:opacity-50"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedInvoice(null)}
                  className="min-h-[42px] px-4 py-2 rounded-lg bg-slate-900 text-white text-xs font-semibold"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODAL 5: MIT License Inspector */}
      {showLicenseModal && (
        <LicenseModal onClose={() => setShowLicenseModal(false)} />
      )}
    </div>
  );
}

function LicenseModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="bg-white w-full sm:max-w-lg rounded-t-3xl sm:rounded-2xl border border-slate-200 p-6 space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2">
            <Scale className="w-4 h-4 text-slate-700" />
            <h3 className="text-base font-bold text-slate-900">MIT License</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <pre className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-xs font-mono text-slate-700 whitespace-pre-wrap leading-relaxed">
          {MIT_LICENSE_TEXT}
        </pre>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
