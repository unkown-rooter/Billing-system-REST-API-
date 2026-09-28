import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Users,
  Terminal,
  ShieldCheck,
  Database,
  Plus,
  Trash2,
  Edit3,
  Copy,
  Check,
  RefreshCw,
  Send,
  AlertCircle,
  Code2,
  Layers,
  Search,
  Sparkles,
  Server as ServerIcon,
  ArrowRight,
  KeyRound,
  Lock,
  UserCheck,
  LogOut,
  ShieldAlert
} from 'lucide-react';

interface Customer {
  id: string;
  accountId: string;
  name: string;
  email: string;
  currency: string;
  createdAt: string;
  updatedAt: string;
}

interface Account {
  id: string;
  email: string;
  role: 'user' | 'admin';
  createdAt: string;
  updatedAt: string;
}

interface ApiResponse<T = any> {
  status: 'success' | 'error';
  data?: T;
  error?: {
    code: string;
    message: string;
    fields?: Array<{ field: string; message: string }>;
  };
}

interface HealthData {
  status: string;
  timestamp: string;
  uptime: number;
  database?: {
    status: string;
  };
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'customers' | 'explorer' | 'validation' | 'docs'>('customers');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCurrency, setSelectedCurrency] = useState<string>('ALL');

  // Authentication State
  const [authToken, setAuthToken] = useState<string | null>(() => localStorage.getItem('billing_auth_token'));
  const [currentAccount, setCurrentAccount] = useState<Account | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authSubmitting, setAuthSubmitting] = useState(false);

  // Health state
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);
  const [lastPingLatency, setLastPingLatency] = useState<number | null>(null);

  // Modal states
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState<Customer | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState<Customer | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Form states
  const [formName, setFormName] = useState('');
  const [formEmail, setFormEmail] = useState('');
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);

  // API Explorer states
  const [explorerMethod, setExplorerMethod] = useState<'GET' | 'POST' | 'PATCH' | 'DELETE'>('GET');
  const [explorerEndpoint, setExplorerEndpoint] = useState('/api/v1/auth/me');
  const [explorerBody, setExplorerBody] = useState('{\n  "email": "operator@billing.com",\n  "password": "SecurePassword123!"\n}');
  const [explorerAttachAuth, setExplorerAttachAuth] = useState(true);
  const [explorerResponse, setExplorerResponse] = useState<{
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
    durationMs: number;
  } | null>(null);
  const [explorerLoading, setExplorerLoading] = useState(false);

  // Copy toast state
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  // Fetch Current User
  const fetchCurrentUser = useCallback(async (token: string) => {
    try {
      const res = await fetch('/api/v1/auth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const json: ApiResponse<Account> = await res.json();
        if (json.data) {
          setCurrentAccount(json.data);
        }
      } else if (res.status === 401) {
        // Token expired or invalid
        setAuthToken(null);
        setCurrentAccount(null);
        localStorage.removeItem('billing_auth_token');
      }
    } catch {
      // Ignore transient network errors during server reload
    }
  }, []);

  useEffect(() => {
    if (authToken) {
      fetchCurrentUser(authToken);
    }
  }, [authToken, fetchCurrentUser]);

  // Fetch Health with automatic retry on transient network error
  const checkHealth = useCallback(async () => {
    setHealthLoading(true);
    const start = performance.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('/api/v1/health');
        const latency = Math.round(performance.now() - start);
        setLastPingLatency(latency);
        if (res.ok) {
          const json: ApiResponse<HealthData> = await res.json();
          if (json.data) {
            setHealth(json.data);
            setHealthLoading(false);
            return;
          }
        }
      } catch {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    }
    setHealth((prev) => prev ?? { status: 'degraded', timestamp: new Date().toISOString(), uptime: 0 });
    setHealthLoading(false);
  }, []);

  // Fetch Customers with automatic retry on transient network error
  const loadCustomers = useCallback(async () => {
    if (!authToken) {
      setCustomers([]);
      setLoadingCustomers(false);
      return;
    }
    setLoadingCustomers(true);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch('/api/v1/customers', {
          headers: { Authorization: `Bearer ${authToken}` },
        });
        if (res.ok) {
          const json: ApiResponse<Customer[]> = await res.json();
          if (json.status === 'success' && Array.isArray(json.data)) {
            setCustomers(json.data);
            setLoadingCustomers(false);
            return;
          }
        } else if (res.status === 401 || res.status === 403) {
          setCustomers([]);
          setLoadingCustomers(false);
          return;
        }
      } catch {
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
    }
    setLoadingCustomers(false);
  }, [authToken]);

  useEffect(() => {
    checkHealth();
    loadCustomers();
    const interval = setInterval(checkHealth, 30000);
    return () => clearInterval(interval);
  }, [checkHealth, loadCustomers]);

  // Auth: Login or Register
  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthSubmitting(true);
    setAuthError(null);

    const endpoint = authMode === 'register' ? '/api/v1/auth/register' : '/api/v1/auth/login';

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: authEmail.trim(),
          password: authPassword,
        }),
      });

      const json = await res.json();
      if (!res.ok || json.status === 'error') {
        const errorMsg =
          json.error?.fields?.map((f: any) => `${f.field}: ${f.message}`).join(', ') ||
          json.error?.message ||
          'Authentication failed';
        setAuthError(errorMsg);
        return;
      }

      if (authMode === 'register') {
        // Automatically switch to login or log in
        setAuthMode('login');
        setAuthError('Registration successful! Please log in with your credentials.');
        return;
      }

      if (authMode === 'login' && json.data?.token) {
        const token = json.data.token;
        setAuthToken(token);
        setCurrentAccount(json.data.account);
        localStorage.setItem('billing_auth_token', token);
        setShowAuthModal(false);
        setAuthPassword('');
        setAuthError(null);
      }
    } catch (err: any) {
      setAuthError(err.message || 'Network error');
    } finally {
      setAuthSubmitting(false);
    }
  };

  const handleLogout = () => {
    setAuthToken(null);
    setCurrentAccount(null);
    setCustomers([]);
    localStorage.removeItem('billing_auth_token');
  };

  // Create Customer
  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormSubmitting(true);
    setFormError(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      const res = await fetch('/api/v1/customers', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          name: formName.trim(),
          email: formEmail.trim(),
          currency: formCurrency.toUpperCase().trim(),
        }),
      });

      const json: ApiResponse<Customer> = await res.json();
      if (!res.ok || json.status === 'error') {
        const errorMsg =
          json.error?.fields?.map(f => `${f.field}: ${f.message}`).join(', ') ||
          json.error?.message ||
          'Failed to create customer';
        setFormError(errorMsg);
        return;
      }

      setShowCreateModal(false);
      setFormName('');
      setFormEmail('');
      setFormCurrency('USD');
      await loadCustomers();
    } catch (err: any) {
      setFormError(err.message || 'Network error');
    } finally {
      setFormSubmitting(false);
    }
  };

  // Edit Customer (PATCH)
  const handleUpdateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showEditModal) return;

    setFormSubmitting(true);
    setFormError(null);

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      const res = await fetch(`/api/v1/customers/${showEditModal.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({
          name: formName.trim(),
          email: formEmail.trim(),
          currency: formCurrency.toUpperCase().trim(),
        }),
      });

      const json: ApiResponse<Customer> = await res.json();
      if (!res.ok || json.status === 'error') {
        const errorMsg =
          json.error?.fields?.map(f => `${f.field}: ${f.message}`).join(', ') ||
          json.error?.message ||
          'Failed to update customer';
        setFormError(errorMsg);
        return;
      }

      setShowEditModal(null);
      await loadCustomers();
    } catch (err: any) {
      setFormError(err.message || 'Network error');
    } finally {
      setFormSubmitting(false);
    }
  };

  // Delete Customer (Requires admin role)
  const handleDeleteCustomer = async () => {
    if (!showDeleteModal) return;
    setFormSubmitting(true);
    setDeleteError(null);

    try {
      const headers: Record<string, string> = {};
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const res = await fetch(`/api/v1/customers/${showDeleteModal.id}`, {
        method: 'DELETE',
        headers,
      });

      if (res.status === 204 || res.ok) {
        setShowDeleteModal(null);
        setDeleteError(null);
        await loadCustomers();
      } else {
        const json = await res.json();
        if (json.error?.code === 'AUTHENTICATION_REQUIRED') {
          setDeleteError('401 Authentication Required: Deleting customer records requires a valid Bearer token.');
        } else if (json.error?.code === 'FORBIDDEN') {
          setDeleteError('403 Forbidden: Only accounts with the "admin" role are authorized to delete customer records.');
        } else {
          setDeleteError(json.error?.message || 'Failed to delete customer');
        }
      }
    } catch (err: any) {
      setDeleteError(err.message || 'Network error');
    } finally {
      setFormSubmitting(false);
    }
  };

  // Quick Seed Demo Data
  const seedDemoData = async () => {
    if (!authToken) {
      setAuthMode('login');
      setAuthError('Please sign in or register an account before creating customer records.');
      setShowAuthModal(true);
      return;
    }
    setLoadingCustomers(true);
    const demoItems = [
      { name: 'Stark Enterprises', email: 'billing@starkenterprises.com', currency: 'USD' },
      { name: 'Wayne Enterprises Holdings', email: 'treasury@wayne.com', currency: 'EUR' },
      { name: 'Cyberdyne Systems Corp', email: 'accounts@cyberdyne.org', currency: 'GBP' },
    ];

    for (const item of demoItems) {
      try {
        await fetch('/api/v1/customers', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify(item),
        });
      } catch {
        // Ignore individual seed item failure if duplicate or transient
      }
    }
    await loadCustomers();
  };

  // Execute API Explorer Request
  const runExplorerRequest = async () => {
    setExplorerLoading(true);
    const start = performance.now();

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      };

      if (explorerAttachAuth && authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const options: RequestInit = {
        method: explorerMethod,
        headers,
      };

      if (explorerMethod === 'POST' || explorerMethod === 'PATCH') {
        options.body = explorerBody;
      }

      const res = await fetch(explorerEndpoint, options);
      const durationMs = Math.round(performance.now() - start);

      const headerMap: Record<string, string> = {};
      res.headers.forEach((val, key) => {
        headerMap[key] = val;
      });

      let parsedBody: any = null;
      const text = await res.text();
      if (text) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      }

      setExplorerResponse({
        status: res.status,
        statusText: res.statusText || (res.status === 200 ? 'OK' : res.status === 201 ? 'Created' : res.status === 204 ? 'No Content' : ''),
        headers: headerMap,
        body: parsedBody,
        durationMs,
      });

      // If user logged in via explorer, automatically update auth state
      if (explorerEndpoint === '/api/v1/auth/login' && res.ok && parsedBody?.data?.token) {
        setAuthToken(parsedBody.data.token);
        setCurrentAccount(parsedBody.data.account);
        localStorage.setItem('billing_auth_token', parsedBody.data.token);
      }

      if (explorerMethod !== 'GET' && explorerEndpoint.startsWith('/api/v1/customers')) {
        loadCustomers();
      }
    } catch (err: any) {
      const durationMs = Math.round(performance.now() - start);
      setExplorerResponse({
        status: 0,
        statusText: 'Client Network Error',
        headers: {},
        body: { error: err.message },
        durationMs,
      });
    } finally {
      setExplorerLoading(false);
    }
  };

  // Quick Preset for Explorer
  const setExplorerPreset = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: string,
    attachAuth: boolean = true
  ) => {
    setExplorerMethod(method);
    setExplorerEndpoint(endpoint);
    setExplorerAttachAuth(attachAuth);
    if (body !== undefined) {
      setExplorerBody(body);
    }
    setActiveTab('explorer');
  };

  // Filtered customers
  const filteredCustomers = customers.filter(c => {
    const matchesSearch =
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.id.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesCurrency = selectedCurrency === 'ALL' || c.currency === selectedCurrency;
    return matchesSearch && matchesCurrency;
  });

  const currencies = Array.from(new Set(customers.map(c => c.currency)));

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-500 selection:text-white">
      {/* Top Navigation Bar */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-indigo-600 via-violet-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-indigo-500/20 ring-1 ring-white/10">
              <ServerIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                  Billing System REST API
                </span>
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wider bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                  Phase 14: Public API Release v1.0.0
                </span>
                <a
                  href="/openapi.yaml"
                  target="_blank"
                  rel="noreferrer"
                  className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 transition"
                >
                  OpenAPI 3.1.0
                </a>
              </div>
              <p className="text-xs text-slate-400">
                Relational Ledger, RBAC/IDOR, Pagination, Security Hardening, Docker, Cloud Run, Observability, Scaling & OpenAPI 3.1
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Authenticated Identity Pill */}
            {currentAccount ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs">
                <UserCheck className="w-4 h-4 text-emerald-400" />
                <div className="text-left hidden sm:block">
                  <div className="flex items-center gap-1.5">
                    <span className="font-semibold text-emerald-300 leading-tight">{currentAccount.email}</span>
                    <span className="px-1.5 py-0.2 rounded text-[10px] font-mono uppercase bg-emerald-950 text-emerald-300 border border-emerald-700/60">
                      {currentAccount.role || 'user'}
                    </span>
                  </div>
                  <div className="text-[10px] font-mono text-emerald-500">{currentAccount.id}</div>
                </div>
                <button
                  onClick={handleLogout}
                  title="Logout"
                  className="ml-1 text-slate-400 hover:text-rose-400 transition"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => {
                  setAuthMode('login');
                  setAuthError(null);
                  setShowAuthModal(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 border border-indigo-500/40 text-xs font-semibold text-indigo-300 transition"
              >
                <KeyRound className="w-3.5 h-3.5" />
                <span>Sign In / Register</span>
              </button>
            )}

            {/* Health Status Indicator */}
            <div className="hidden sm:flex items-center gap-3 px-3 py-1.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-xs">
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${health?.status === 'healthy' ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${health?.status === 'healthy' ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
              </span>
              <span className="text-slate-300 font-medium">
                {health?.status === 'healthy' ? 'API Online' : 'Degraded'}
              </span>
              {lastPingLatency !== null && (
                <span className="text-slate-500 font-mono text-[11px] border-l border-slate-700 pl-2">
                  {lastPingLatency}ms
                </span>
              )}
              <button
                onClick={checkHealth}
                disabled={healthLoading}
                title="Ping Health"
                className="text-slate-400 hover:text-white transition p-0.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${healthLoading ? 'animate-spin text-indigo-400' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex space-x-1 border-t border-slate-800/60 overflow-x-auto scrollbar-none">
          <button
            onClick={() => setActiveTab('customers')}
            className={`flex items-center gap-2 py-3 px-4 text-sm font-medium border-b-2 transition whitespace-nowrap ${
              activeTab === 'customers'
                ? 'border-indigo-500 text-white bg-indigo-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Customers Ledger</span>
            <span className="ml-1.5 px-1.5 py-0.2 rounded-full text-xs bg-slate-800 text-slate-300">
              {customers.length}
            </span>
          </button>

          <button
            onClick={() => setActiveTab('explorer')}
            className={`flex items-center gap-2 py-3 px-4 text-sm font-medium border-b-2 transition whitespace-nowrap ${
              activeTab === 'explorer'
                ? 'border-indigo-500 text-white bg-indigo-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            <Terminal className="w-4 h-4" />
            <span>Interactive API Explorer</span>
          </button>

          <button
            onClick={() => setActiveTab('validation')}
            className={`flex items-center gap-2 py-3 px-4 text-sm font-medium border-b-2 transition whitespace-nowrap ${
              activeTab === 'validation'
                ? 'border-indigo-500 text-white bg-indigo-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            <ShieldCheck className="w-4 h-4" />
            <span>Schema & Validation Lab</span>
          </button>

          <button
            onClick={() => setActiveTab('docs')}
            className={`flex items-center gap-2 py-3 px-4 text-sm font-medium border-b-2 transition whitespace-nowrap ${
              activeTab === 'docs'
                ? 'border-indigo-500 text-white bg-indigo-500/5'
                : 'border-transparent text-slate-400 hover:text-slate-200 hover:border-slate-700'
            }`}
          >
            <Code2 className="w-4 h-4" />
            <span>API Docs & Architecture</span>
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8">
        {/* TAB 1: CUSTOMERS LEDGER */}
        {activeTab === 'customers' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 shadow-sm flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Total Customers</p>
                  <p className="text-2xl font-bold text-white mt-1">{customers.length}</p>
                </div>
                <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-lg">
                  <Users className="w-6 h-6" />
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 shadow-sm flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Active Currencies</p>
                  <p className="text-2xl font-bold text-emerald-400 mt-1">{currencies.length || 0}</p>
                </div>
                <div className="p-3 bg-emerald-500/10 text-emerald-400 rounded-lg">
                  <Activity className="w-6 h-6" />
                </div>
              </div>

              <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 shadow-sm flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-slate-400 font-semibold">Access Policy</p>
                  <p className="text-2xl font-bold text-indigo-300 mt-1 flex items-center gap-1.5">
                    <Lock className="w-5 h-5 text-indigo-400 inline" />
                    <span>{currentAccount ? `Role: ${currentAccount.role}` : 'Owner + RBAC'}</span>
                  </p>
                </div>
                <div className="p-3 bg-indigo-500/10 text-indigo-400 rounded-lg">
                  <KeyRound className="w-6 h-6" />
                </div>
              </div>
            </div>

            {/* Filter and Action Header */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 bg-slate-900/40 p-4 rounded-xl border border-slate-800">
              <div className="flex flex-1 items-center gap-3">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    placeholder="Search by name, email, or cus_ ID..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-9 pr-4 py-2 bg-slate-950/80 border border-slate-800 rounded-lg text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition"
                  />
                </div>

                {currencies.length > 0 && (
                  <select
                    value={selectedCurrency}
                    onChange={(e) => setSelectedCurrency(e.target.value)}
                    className="px-3 py-2 bg-slate-950/80 border border-slate-800 rounded-lg text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="ALL">All Currencies</option>
                    {currencies.map(curr => (
                      <option key={curr} value={curr}>{curr}</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex items-center gap-2">
                {customers.length === 0 && (
                  <button
                    onClick={seedDemoData}
                    disabled={loadingCustomers}
                    className="flex items-center gap-1.5 px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-sm font-medium transition border border-slate-700"
                  >
                    <Sparkles className="w-4 h-4 text-amber-400" />
                    <span>Seed Demo Records</span>
                  </button>
                )}

                <button
                  onClick={() => {
                    setFormName('');
                    setFormEmail('');
                    setFormCurrency('USD');
                    setFormError(null);
                    setShowCreateModal(true);
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition shadow-lg shadow-indigo-600/25"
                >
                  <Plus className="w-4 h-4" />
                  <span>Create Customer</span>
                </button>
              </div>
            </div>

            {/* Customers Table */}
            <div className="bg-slate-900/50 rounded-xl border border-slate-800 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm text-slate-300">
                  <thead className="bg-slate-900 border-b border-slate-800 text-xs uppercase font-semibold text-slate-400 tracking-wider">
                    <tr>
                      <th className="py-3.5 px-4">Customer Identity</th>
                      <th className="py-3.5 px-4">Public ID</th>
                      <th className="py-3.5 px-4">Ledger Currency</th>
                      <th className="py-3.5 px-4">Created Date</th>
                      <th className="py-3.5 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {loadingCustomers ? (
                      <tr>
                        <td colSpan={5} className="py-12 text-center text-slate-500">
                          <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-indigo-400" />
                          <span>Loading customer ledger records...</span>
                        </td>
                      </tr>
                    ) : filteredCustomers.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="py-12 text-center">
                          <div className="max-w-md mx-auto space-y-3">
                            <div className="w-12 h-12 rounded-full bg-slate-800 flex items-center justify-center mx-auto text-slate-400">
                              <Users className="w-6 h-6" />
                            </div>
                            <h3 className="font-semibold text-slate-200">No Customers Found</h3>
                            <p className="text-xs text-slate-400">
                              {customers.length === 0
                                ? 'The ledger is currently pristine and empty. Create a customer manually or seed demo accounts.'
                                : 'No records match your search filter.'}
                            </p>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      filteredCustomers.map((cust) => (
                        <tr key={cust.id} className="hover:bg-slate-800/40 transition group">
                          <td className="py-3.5 px-4">
                            <div className="font-medium text-white">{cust.name}</div>
                            <div className="text-xs text-slate-400">{cust.email}</div>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs text-indigo-300 bg-indigo-950/40 px-2 py-0.5 rounded border border-indigo-800/50">
                                {cust.id}
                              </span>
                              <button
                                onClick={() => copyToClipboard(cust.id, cust.id)}
                                className="text-slate-500 hover:text-slate-300 opacity-0 group-hover:opacity-100 transition p-1"
                                title="Copy ID"
                              >
                                {copiedKey === cust.id ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                              {cust.currency}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-xs text-slate-400 font-mono">
                            {new Date(cust.createdAt).toLocaleString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => {
                                  setExplorerPreset('GET', `/api/v1/customers/${cust.id}`);
                                }}
                                className="p-1.5 text-slate-400 hover:text-indigo-400 hover:bg-slate-800 rounded transition"
                                title="Inspect in API Explorer"
                              >
                                <Terminal className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => {
                                  setShowEditModal(cust);
                                  setFormName(cust.name);
                                  setFormEmail(cust.email);
                                  setFormCurrency(cust.currency);
                                  setFormError(null);
                                }}
                                className="p-1.5 text-slate-400 hover:text-amber-400 hover:bg-slate-800 rounded transition"
                                title="Edit Customer (PATCH)"
                              >
                                <Edit3 className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => {
                                  setDeleteError(null);
                                  setShowDeleteModal(cust);
                                }}
                                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded transition flex items-center gap-1"
                                title="Delete Customer (Protected: Requires Auth)"
                              >
                                <Lock className="w-3 h-3 text-indigo-400" />
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: INTERACTIVE API EXPLORER */}
        {activeTab === 'explorer' && (
          <div className="space-y-6">
            <div className="bg-slate-900/60 p-4 rounded-xl border border-slate-800">
              <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-white">Live Request Playground</h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Execute real HTTP requests to the backend Express endpoints, test Bearer token verification, and inspect JSON envelopes.
                  </p>
                </div>
                {authToken && (
                  <div className="flex items-center gap-2 px-2.5 py-1 rounded bg-slate-800 border border-slate-700 text-xs">
                    <label className="flex items-center gap-1.5 text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={explorerAttachAuth}
                        onChange={(e) => setExplorerAttachAuth(e.target.checked)}
                        className="rounded bg-slate-950 border-slate-700 text-indigo-600 focus:ring-0"
                      />
                      <span>Attach Bearer Token</span>
                    </label>
                  </div>
                )}
              </div>

              {/* Quick Presets */}
              <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-slate-800">
                <span className="text-xs text-slate-500 py-1">Quick Presets:</span>
                <button
                  onClick={() => setExplorerPreset('POST', '/api/v1/auth/register', JSON.stringify({ email: 'operator@billing.com', password: 'SecurePassword123!' }, null, 2), false)}
                  className="px-2.5 py-1 text-xs rounded bg-indigo-950/60 hover:bg-indigo-900 text-indigo-300 border border-indigo-800/40 font-mono transition"
                >
                  POST /auth/register
                </button>
                <button
                  onClick={() => setExplorerPreset('POST', '/api/v1/auth/login', JSON.stringify({ email: 'operator@billing.com', password: 'SecurePassword123!' }, null, 2), false)}
                  className="px-2.5 py-1 text-xs rounded bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-800/40 font-mono transition"
                >
                  POST /auth/login
                </button>
                <button
                  onClick={() => setExplorerPreset('GET', '/api/v1/auth/me', undefined, true)}
                  className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-200 font-mono transition flex items-center gap-1"
                >
                  <Lock className="w-3 h-3 text-indigo-400" />
                  <span>GET /auth/me</span>
                </button>
                <button
                  onClick={() => setExplorerPreset('GET', '/api/v1/customers?page=1&limit=10&sort=createdAt&order=desc', undefined, true)}
                  className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono transition"
                >
                  GET /customers?page=1&limit=10
                </button>
                <button
                  onClick={() => setExplorerPreset('GET', '/api/v1/invoices?page=1&limit=10&sort=total&order=desc', undefined, true)}
                  className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono transition"
                >
                  GET /invoices?page=1&sort=total
                </button>
                <button
                  onClick={() =>
                    setExplorerPreset(
                      'POST',
                      `/api/v1/customers/${customers[0]?.id || 'cus_demo_id'}/invoices`,
                      JSON.stringify(
                        {
                          tax: 6.41,
                          discount: 5.0,
                          items: [
                            { description: 'Dedicated Compute Node (vCPU x8)', quantity: 3, unitPrice: 19.99 },
                            { description: 'Managed Block Storage (TB)', quantity: 2, unitPrice: 10.05 },
                          ],
                        },
                        null,
                        2
                      ),
                      true
                    )
                  }
                  className="px-2.5 py-1 text-xs rounded bg-emerald-950/60 hover:bg-emerald-900 text-emerald-300 border border-emerald-800/40 font-mono transition"
                >
                  POST /customers/:id/invoices
                </button>
                <button
                  onClick={() => setExplorerPreset('GET', '/api/v1/health', undefined, false)}
                  className="px-2.5 py-1 text-xs rounded bg-slate-800 hover:bg-slate-700 text-slate-300 font-mono transition"
                >
                  GET /health
                </button>
              </div>
            </div>

            {/* Request Bar */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left Column: Request Builder */}
              <div className="space-y-4">
                <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800 space-y-4">
                  <div className="flex items-center gap-2">
                    <select
                      value={explorerMethod}
                      onChange={(e) => setExplorerMethod(e.target.value as any)}
                      className={`px-3 py-2 rounded-lg text-xs font-bold font-mono tracking-wider focus:outline-none ${
                        explorerMethod === 'GET'
                          ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                          : explorerMethod === 'POST'
                          ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                          : explorerMethod === 'PATCH'
                          ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                          : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                      }`}
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PATCH">PATCH</option>
                      <option value="DELETE">DELETE</option>
                    </select>

                    <input
                      type="text"
                      value={explorerEndpoint}
                      onChange={(e) => setExplorerEndpoint(e.target.value)}
                      placeholder="/api/v1/auth/me"
                      className="flex-1 px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-slate-200 focus:outline-none focus:border-indigo-500"
                    />

                    <button
                      onClick={runExplorerRequest}
                      disabled={explorerLoading}
                      className="flex items-center gap-2 px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-semibold transition disabled:opacity-50 shadow-md shadow-indigo-600/30"
                    >
                      <Send className={`w-4 h-4 ${explorerLoading ? 'animate-pulse' : ''}`} />
                      <span>{explorerLoading ? 'Sending...' : 'Send'}</span>
                    </button>
                  </div>

                  {/* Authorization header preview */}
                  <div className="flex items-center justify-between text-xs px-3 py-2 rounded-lg bg-slate-950 border border-slate-800">
                    <div className="flex items-center gap-2">
                      <KeyRound className="w-3.5 h-3.5 text-indigo-400" />
                      <span className="text-slate-400 font-mono">Authorization:</span>
                    </div>
                    {explorerAttachAuth && authToken ? (
                      <span className="font-mono text-emerald-400 text-[11px] truncate max-w-[240px]">
                        Bearer {authToken.substring(0, 18)}...
                      </span>
                    ) : (
                      <span className="text-slate-500 text-[11px] font-mono">(None - Unauthenticated)</span>
                    )}
                  </div>

                  {/* Request Body (for POST / PATCH) */}
                  {(explorerMethod === 'POST' || explorerMethod === 'PATCH') && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between text-xs text-slate-400">
                        <span>Request Body (JSON):</span>
                        <button
                          onClick={() => {
                            try {
                              setExplorerBody(JSON.stringify(JSON.parse(explorerBody), null, 2));
                            } catch {}
                          }}
                          className="text-indigo-400 hover:underline"
                        >
                          Prettify JSON
                        </button>
                      </div>
                      <textarea
                        rows={8}
                        value={explorerBody}
                        onChange={(e) => setExplorerBody(e.target.value)}
                        className="w-full p-3 bg-slate-950 border border-slate-800 rounded-lg font-mono text-xs text-emerald-300 focus:outline-none focus:border-indigo-500 resize-none"
                      />
                    </div>
                  )}

                  {/* Generated cURL command */}
                  <div className="pt-2 border-t border-slate-800/80">
                    <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
                      <span>Equivalent cURL:</span>
                      <button
                        onClick={() => {
                          const authPart = explorerAttachAuth && authToken ? `-H "Authorization: Bearer ${authToken}" ` : '';
                          const bodyPart = explorerMethod === 'POST' || explorerMethod === 'PATCH'
                            ? `-H "Content-Type: application/json" -d '${explorerBody.replace(/\n/g, '')}'`
                            : '';
                          const curl = `curl -X ${explorerMethod} "http://localhost:3000${explorerEndpoint}" ${authPart}${bodyPart}`;
                          copyToClipboard(curl, 'curl_copy');
                        }}
                        className="text-xs text-indigo-400 hover:text-indigo-300 flex items-center gap-1"
                      >
                        {copiedKey === 'curl_copy' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                        <span>Copy cURL</span>
                      </button>
                    </div>
                    <pre className="p-2.5 bg-slate-950/80 border border-slate-800/80 rounded font-mono text-[11px] text-slate-400 overflow-x-auto">
                      {`curl -X ${explorerMethod} "${explorerEndpoint}" ${explorerAttachAuth && authToken ? `-H "Authorization: Bearer <token>" ` : ''}`}
                    </pre>
                  </div>
                </div>
              </div>

              {/* Right Column: Response Viewer */}
              <div className="space-y-4">
                <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800 flex flex-col h-full min-h-[380px]">
                  <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                    <span className="text-xs uppercase tracking-wider font-semibold text-slate-400">Response</span>
                    {explorerResponse ? (
                      <div className="flex items-center gap-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-mono font-bold ${
                          explorerResponse.status >= 200 && explorerResponse.status < 300
                            ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                            : explorerResponse.status === 401
                            ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                            : explorerResponse.status >= 400 && explorerResponse.status < 500
                            ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                            : 'bg-rose-500/20 text-rose-400 border border-rose-500/30'
                        }`}>
                          {explorerResponse.status} {explorerResponse.statusText}
                        </span>
                        <span className="text-xs font-mono text-slate-400">
                          {explorerResponse.durationMs}ms
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-slate-500 font-mono">Ready</span>
                    )}
                  </div>

                  <div className="flex-1 mt-3">
                    {explorerResponse ? (
                      <div className="space-y-3 h-full flex flex-col">
                        {explorerResponse.headers['location'] && (
                          <div className="p-2 rounded bg-indigo-950/30 border border-indigo-800/40 text-xs font-mono text-indigo-300">
                            Location: {explorerResponse.headers['location']}
                          </div>
                        )}

                        <div className="flex-1 relative">
                          <pre className="p-4 bg-slate-950 border border-slate-800 rounded-lg font-mono text-xs text-slate-200 overflow-auto max-h-[360px] h-full">
                            {explorerResponse.body !== null
                              ? JSON.stringify(explorerResponse.body, null, 2)
                              : '(Empty Body - e.g. 204 No Content)'}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center text-center p-8 text-slate-500">
                        <Terminal className="w-10 h-10 mb-3 opacity-40" />
                        <p className="text-sm font-medium text-slate-400">No Request Sent Yet</p>
                        <p className="text-xs text-slate-500 mt-1 max-w-xs">
                          Choose an endpoint and click Send to inspect live status codes and JSON envelopes.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: SCHEMA & VALIDATION LAB */}
        {activeTab === 'validation' && (
          <div className="space-y-6">
            <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-base font-semibold text-white flex items-center gap-2">
                    <ShieldCheck className="w-5 h-5 text-indigo-400" />
                    <span>Schema Validation, Security Hardening & Container Runtime Lab</span>
                  </h2>
                  <p className="text-xs text-slate-400 mt-1">
                    Directly test authentication contracts, RBAC/IDOR boundaries, pagination & filter guards, HTTP security headers, and structured error responses across Phases 1–12.
                  </p>
                </div>
                <span className="px-2.5 py-1 rounded bg-indigo-500/10 text-indigo-300 text-xs font-mono border border-indigo-500/20">
                  242 Automated Tests Passing (16 Suites)
                </span>
              </div>
            </div>

            {/* Invariant Test Scenarios Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Auth Scenario 1: Missing Token */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      HTTP 401 AUTHENTICATION_REQUIRED
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">GET</span>
                  </div>
                  <h3 className="font-semibold text-sm text-slate-200 mt-2">Missing Bearer Credential</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Calls <code>GET /api/v1/auth/me</code> without Authorization header. Verifies immediate 401 rejection.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setExplorerPreset('GET', '/api/v1/auth/me', undefined, false);
                    runExplorerRequest();
                  }}
                  className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <span>Test In Explorer</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Auth Scenario 2: Invalid Token Signature */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      HTTP 401 INVALID_TOKEN
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">GET</span>
                  </div>
                  <h3 className="font-semibold text-sm text-slate-200 mt-2">Tampered Token Signature</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Supplies malformed or tampered JWT. Cryptographic verification catches HMAC mismatch and rejects.
                  </p>
                </div>
                <button
                  onClick={async () => {
                    setExplorerMethod('GET');
                    setExplorerEndpoint('/api/v1/auth/me');
                    setExplorerAttachAuth(false);
                    setActiveTab('explorer');
                    setExplorerLoading(true);
                    try {
                      const res = await fetch('/api/v1/auth/me', {
                        headers: { Authorization: 'Bearer fake.invalid.token' },
                      });
                      const json = await res.json();
                      setExplorerResponse({
                        status: res.status,
                        statusText: 'Unauthorized',
                        headers: {},
                        body: json,
                        durationMs: 2,
                      });
                    } catch (err: any) {
                      setExplorerResponse({
                        status: 0,
                        statusText: 'Client Network Error',
                        headers: {},
                        body: { error: err.message },
                        durationMs: 0,
                      });
                    } finally {
                      setExplorerLoading(false);
                    }
                  }}
                  className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <span>Test In Explorer</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Auth Scenario 3: Nonexistent User Login (Timing Attack Defense) */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      HTTP 401 INVALID_CREDENTIALS
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">POST</span>
                  </div>
                  <h3 className="font-semibold text-sm text-slate-200 mt-2">Anti-Enumeration Login</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Attempts login with nonexistent email. Executes dummy scrypt hash to prevent timing enumeration.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setExplorerPreset('POST', '/api/v1/auth/login', JSON.stringify({ email: 'ghost_user@nonexistent.com', password: 'Password123!' }, null, 2), false);
                    runExplorerRequest();
                  }}
                  className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <span>Test In Explorer</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Auth Scenario 4: Short Password */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      HTTP 400 VALIDATION_ERROR
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">POST</span>
                  </div>
                  <h3 className="font-semibold text-sm text-slate-200 mt-2">Password Policy Violation</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Supplies 5-character password. Policy enforces minimum 8 characters and non-whitespace.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setExplorerPreset('POST', '/api/v1/auth/register', JSON.stringify({ email: 'policy@test.com', password: 'short' }, null, 2), false);
                    runExplorerRequest();
                  }}
                  className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <span>Test In Explorer</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Scenario 5: Privilege Escalation Prevention */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                      HTTP 400 VALIDATION_ERROR
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">POST</span>
                  </div>
                  <h3 className="font-semibold text-sm text-slate-200 mt-2">Self-Promotion Blocked</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Attempts <code>POST /api/v1/auth/register</code> with <code>"role": "admin"</code>. Rejected at validation & service layers.
                  </p>
                </div>
                <button
                  onClick={() => {
                    setExplorerPreset(
                      'POST',
                      '/api/v1/auth/register',
                      JSON.stringify({ email: 'escalate@attacker.com', password: 'ValidPassword123!', role: 'admin' }, null, 2),
                      false
                    );
                    runExplorerRequest();
                  }}
                  className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <span>Test In Explorer</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Scenario 6: Protected Admin-Only DELETE */}
              <div className="p-4 rounded-xl bg-slate-900/40 border border-slate-800 hover:border-slate-700 transition flex flex-col justify-between space-y-3">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">
                      HTTP 403 FORBIDDEN
                    </span>
                    <span className="text-[11px] text-slate-500 font-mono">DELETE</span>
                  </div>
                  <h3 className="font-semibold text-sm text-slate-200 mt-2">Admin-Only DELETE Policy</h3>
                  <p className="text-xs text-slate-400 mt-1">
                    Attempts <code>DELETE /api/v1/customers/:id</code> as a standard <code>user</code> role. Rejects with <code>403 FORBIDDEN</code>.
                  </p>
                </div>
                <button
                  onClick={() => {
                    const id = customers[0]?.id || 'cus_demo_id';
                    setExplorerPreset('DELETE', `/api/v1/customers/${id}`, undefined, true);
                    runExplorerRequest();
                  }}
                  className="w-full py-1.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded text-xs font-medium flex items-center justify-center gap-1.5 transition"
                >
                  <span>Test In Explorer</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Error Architecture Reference Table */}
            <div className="bg-slate-900/60 p-5 rounded-xl border border-slate-800">
              <h3 className="text-sm font-semibold text-white mb-3">Unified Error Vocabulary (Phases 1–11)</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left text-slate-300">
                  <thead className="bg-slate-950 border-b border-slate-800 font-semibold text-slate-400 uppercase tracking-wider">
                    <tr>
                      <th className="py-2.5 px-3">Error Code</th>
                      <th className="py-2.5 px-3">HTTP Status</th>
                      <th className="py-2.5 px-3">Lifecycle Trigger</th>
                      <th className="py-2.5 px-3">Security Guarantee</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-mono">
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">AUTHENTICATION_REQUIRED</td>
                      <td className="py-2.5 px-3">401 Unauthorized</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Auth Middleware</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Missing Authorization header on protected route</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">INVALID_CREDENTIALS</td>
                      <td className="py-2.5 px-3">401 Unauthorized</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Auth Service Login</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Identical message for unknown email and wrong password</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">INVALID_TOKEN</td>
                      <td className="py-2.5 px-3">401 Unauthorized</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Token Verification</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Rejects malformed tokens, alg:none, or signature mismatches</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">TOKEN_EXPIRED</td>
                      <td className="py-2.5 px-3">401 Unauthorized</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Token Verification</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Rejects tokens past their expiration timestamp</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">FORBIDDEN</td>
                      <td className="py-2.5 px-3">403 Forbidden</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Authorize Middleware / Service Policy</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Insufficient role or cross-account IDOR attempt (zero data leak)</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-amber-400">VALIDATION_ERROR</td>
                      <td className="py-2.5 px-3">400 Bad Request</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Validation Schema</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Returns granular <code>fields[]</code> diagnostics & blocks prototype/null-byte injection</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-amber-400">METHOD_NOT_ALLOWED</td>
                      <td className="py-2.5 px-3">405 Method Not Allowed</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Route Method Guard</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Rejects unsupported HTTP verbs with explicit RFC 9110 <code>Allow</code> header</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">DUPLICATE_RESOURCE</td>
                      <td className="py-2.5 px-3">409 Conflict</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">DB Unique Index</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Case-insensitive unique email or invoice number conflict</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">CONFLICT</td>
                      <td className="py-2.5 px-3">409 Conflict</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Relational / State Guard</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">ON DELETE RESTRICT customer with invoices or paid invoice mutation</td>
                    </tr>
                    <tr>
                      <td className="py-2.5 px-3 text-rose-400">RATE_LIMIT_EXCEEDED</td>
                      <td className="py-2.5 px-3">429 Too Many Requests</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Auth / API Rate Limiter</td>
                      <td className="py-2.5 px-3 font-sans text-slate-400">Throttles brute-force & high-rate floods with <code>Retry-After</code> header</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 4: API DOCS & ARCHITECTURE */}
        {activeTab === 'docs' && (
          <div className="space-y-6">
            {/* Phase 4 Identity Model */}
            <div className="bg-slate-900/60 p-6 rounded-xl border border-slate-800 space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-indigo-400" />
                <span>Phase 4 Identity Model: Customer vs Account</span>
              </h2>
              <p className="text-xs text-slate-300 leading-relaxed">
                In a billing ledger system, an intentional architectural boundary separates <strong>Account</strong> (the authenticated API user / operator) from <strong>Customer</strong> (the billed party receiving invoices).
              </p>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-sm text-indigo-300">
                    <UserCheck className="w-4 h-4" />
                    <span>Account (Identity Layer)</span>
                  </div>
                  <ul className="text-xs text-slate-400 space-y-1 font-mono">
                    <li>- id: acc_&lt;uuidv4&gt;</li>
                    <li>- email: operator@billing.com</li>
                    <li>- passwordHash: scrypt$... (Never exposed)</li>
                    <li>- Scope: Signs in, issues Bearer tokens</li>
                  </ul>
                </div>

                <div className="p-4 rounded-lg bg-slate-950 border border-slate-800 space-y-2">
                  <div className="flex items-center gap-2 font-semibold text-sm text-emerald-300">
                    <Users className="w-4 h-4" />
                    <span>Customer (Billing Domain)</span>
                  </div>
                  <ul className="text-xs text-slate-400 space-y-1 font-mono">
                    <li>- id: cus_&lt;uuidv4&gt;</li>
                    <li>- name: Wayne Enterprises</li>
                    <li>- currency: USD (ISO 4217)</li>
                    <li>- Scope: Receives invoices & payments</li>
                  </ul>
                </div>
              </div>
            </div>

            {/* Architecture Overview */}
            <div className="bg-slate-900/60 p-6 rounded-xl border border-slate-800 space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Layers className="w-5 h-5 text-indigo-400" />
                <span>Phases 1–11 Cloud Run HTTPS Ingress, Security & Container Runtime Lifecycle</span>
              </h2>

              <div className="p-4 bg-slate-950 rounded-lg border border-slate-800/80 font-mono text-xs text-slate-300 overflow-x-auto">
                <pre>{`HTTPS Client Request (TLS Termination at Cloud Run Edge → X-Forwarded-Proto: https)
     ↓
Container Port 3000 (Non-Root USER node UID 1000, Read-Only Rootfs, TRUST_PROXY=1)
     ↓
Security & Transport Hardening (Phases 9–11)
     ├── Disable 'X-Powered-By'
     ├── SecurityHeaders (nosniff, DENY, CSP, no-store, HSTS max-age=31536000)
     ├── Restrictive CORS Policy (CORS_ALLOWED_ORIGINS whitelist)
     ├── express.json({ limit: '100kb', strict: false })
     └── Redacted Request Logger (CRLF & secret redaction)
     ↓
Express Router (/api/v1 + General API Rate Limiter)
     ├── /health              → HealthController (GET 200/503, 405 on other verbs)
     ├── /auth/register       → authRateLimiter → validateRegisterBody → AuthController.register
     ├── /auth/login          → authRateLimiter → validateLoginBody    → AuthController.login
     ├── /auth/me             → authenticate    → AuthController.getMe
     ├── /customers           → authenticate    → Pagination/Filter/Sort + Ownership/RBAC
     ├── /customers/:id/invoices → authenticate → Scoped Customer Invoice Ledger
     ├── /invoices            → authenticate    → Atomic Transaction (Invoice + Items)
     └── /invoices/:id/items  → authenticate    → Line Item Addition & Calculation
     ↓
PostgreSQL 15 Production Pool (pg.Pool → billing_system_prod)
     ├── Strict DB Isolation: billing_system (Dev) ≠ billing_system_test (Test) ≠ billing_system_prod (Prod)
     ├── Parameterized SQL ($1, $2, ...) + Whitelisted ORDER BY columns
     ├── Integer-cents financial arithmetic (subtotal + tax - discount = total)
     └── Clean SIGTERM graceful HTTP + Pool drain in Docker container`}</pre>
              </div>
            </div>

            {/* Database Migrations */}
            <div className="bg-slate-900/60 p-6 rounded-xl border border-slate-800 space-y-4">
              <h2 className="text-base font-semibold text-white flex items-center gap-2">
                <Database className="w-5 h-5 text-indigo-400" />
                <span>PostgreSQL Versioned Schema & Scaling Migrations (001–006)</span>
              </h2>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs">
                  <div className="text-slate-400 font-bold mb-2">001 & 002: Customers & Accounts</div>
                  <pre className="text-emerald-300 text-[11px] overflow-x-auto">{`-- 001_create_customers_table.sql
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(254) NOT NULL,
  currency CHAR(3) NOT NULL
);
-- 002_create_accounts_table.sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  password_hash TEXT NOT NULL
);`}</pre>
                </div>

                <div className="p-3 bg-slate-950 rounded-lg border border-slate-800 font-mono text-xs">
                  <div className="text-slate-400 font-bold mb-2">003–006: RBAC, Invoices & Composite Scaling Indexes</div>
                  <pre className="text-indigo-300 text-[11px] overflow-x-auto">{`-- 003: accounts.role ('user'|'admin') & customers.account_id
-- 004: invoices (ON DELETE RESTRICT) & invoice_items (CASCADE)
-- 005: B-Tree indexes on currency, status, issue_date, due_date, created_at
-- 006: Composite & functional indexes for O(log N) tenant pagination:
CREATE UNIQUE INDEX idx_invoices_invoice_number_upper ON invoices (UPPER(invoice_number));
CREATE INDEX idx_customers_account_created_id ON customers (account_id, created_at, id);
CREATE INDEX idx_invoices_customer_status_created_id ON invoices (customer_id, status, created_at, id);
CREATE INDEX idx_invoice_items_invoice_created_id ON invoice_items (invoice_id, created_at, id);`}</pre>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* AUTH MODAL (LOGIN / REGISTER) */}
      {showAuthModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <KeyRound className="w-5 h-5 text-indigo-400" />
                <h3 className="font-semibold text-white text-base">
                  {authMode === 'login' ? 'Sign In to API' : 'Register API Account'}
                </h3>
              </div>
              <button
                onClick={() => setShowAuthModal(false)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            {authError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{authError}</span>
              </div>
            )}

            <form onSubmit={handleAuthSubmit} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Email Address *
                </label>
                <input
                  type="email"
                  required
                  placeholder="operator@billing.com"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Password (min 8 chars) *
                </label>
                <input
                  type="password"
                  required
                  placeholder="••••••••••••"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-between pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMode(authMode === 'login' ? 'register' : 'login');
                    setAuthError(null);
                  }}
                  className="text-xs text-indigo-400 hover:underline"
                >
                  {authMode === 'login' ? 'Need an account? Register' : 'Already have an account? Sign in'}
                </button>

                <button
                  type="submit"
                  disabled={authSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition disabled:opacity-50"
                >
                  {authSubmitting
                    ? 'Processing...'
                    : authMode === 'login'
                    ? 'Sign In'
                    : 'Register Account'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* CREATE CUSTOMER MODAL */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <h3 className="font-semibold text-white text-base">Create New Customer</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            {formError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleCreateCustomer} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Customer / Business Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Wayne Enterprises"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Billing Email *
                </label>
                <input
                  type="email"
                  required
                  placeholder="finance@wayne.com"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Currency (3-Letter ISO 4217) *
                </label>
                <input
                  type="text"
                  required
                  maxLength={3}
                  placeholder="USD"
                  value={formCurrency}
                  onChange={(e) => setFormCurrency(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formSubmitting}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow transition disabled:opacity-50"
                >
                  {formSubmitting ? 'Creating...' : 'Create Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* EDIT CUSTOMER MODAL (PATCH) */}
      {showEditModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div>
                <h3 className="font-semibold text-white text-base">Update Customer (PATCH)</h3>
                <p className="text-xs font-mono text-indigo-400 mt-0.5">{showEditModal.id}</p>
              </div>
              <button
                onClick={() => setShowEditModal(null)}
                className="text-slate-400 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            {formError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleUpdateCustomer} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Currency (ISO 4217)
                </label>
                <input
                  type="text"
                  maxLength={3}
                  value={formCurrency}
                  onChange={(e) => setFormCurrency(e.target.value.toUpperCase())}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-sm font-mono text-white focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowEditModal(null)}
                  className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={formSubmitting}
                  className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-semibold shadow transition disabled:opacity-50"
                >
                  {formSubmitting ? 'Saving...' : 'Apply Partial Update'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* DELETE CONFIRMATION MODAL */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-sm w-full p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-rose-500/10 text-rose-400 rounded-full">
                <Trash2 className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-semibold text-white text-base">Delete Customer</h3>
                <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                  <Lock className="w-3 h-3 text-indigo-400 inline" />
                  <span>Protected Endpoint (Requires Bearer Token)</span>
                </p>
              </div>
            </div>

            <p className="text-xs text-slate-300">
              Are you sure you want to delete customer <strong className="text-white">{showDeleteModal.name}</strong> ({showDeleteModal.id})? This action is irreversible.
            </p>

            {deleteError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs space-y-2">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  <span>{deleteError}</span>
                </div>
                {!authToken && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowDeleteModal(null);
                      setDeleteError(null);
                      setAuthMode('login');
                      setAuthError(null);
                      setShowAuthModal(true);
                    }}
                    className="w-full py-1.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded text-xs font-semibold transition"
                  >
                    Sign In / Register Now
                  </button>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowDeleteModal(null);
                  setDeleteError(null);
                }}
                className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-medium transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteCustomer}
                disabled={formSubmitting}
                className="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold shadow transition disabled:opacity-50"
              >
                {formSubmitting ? 'Deleting...' : 'Delete Record'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
