import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AiChat } from "@/components/AiChat";
import Dashboard from "@/pages/Dashboard";
import DeployPage from "@/pages/deploy";
import NotFound from "@/pages/not-found";
import { Component, type ErrorInfo, type ReactNode } from "react";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('React crash:', error, info); }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, fontFamily: 'monospace', color: '#f87171', background: '#18181b', minHeight: '100vh' }}>
          <h1>Dashboard Error</h1>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{this.state.error.message}</pre>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#a1a1aa', fontSize: 12, marginTop: 16 }}>{this.state.error.stack}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 20, padding: '8px 16px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer' }}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function LoginScreen({ error, debugRoles }: { error?: string; debugRoles?: string }) {
  const errorMessages: Record<string, string> = {
    no_access: 'Nemaš pristup. Samo Gazda, Sugazda, Suvlasnik, Vlasnik i Upravitelj mogu koristiti dashboard.',
    token_failed: 'Discord autentikacija neuspješna. Pokušaj ponovo.',
    auth_failed: 'Greška prilikom prijave. Pokušaj ponovo.',
    no_code: 'Greška u OAuth procesu.',
  };
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, -apple-system, sans-serif', position: 'relative', overflow: 'hidden', background: '#080c14' }}>
      {/* Animated background */}
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 20% 50%, rgba(34, 197, 94, 0.08) 0%, transparent 60%), radial-gradient(ellipse at 80% 20%, rgba(59, 130, 246, 0.06) 0%, transparent 50%), radial-gradient(ellipse at 50% 80%, rgba(168, 85, 247, 0.05) 0%, transparent 50%)' }} />
      {/* Grid overlay */}
      <div style={{ position: 'absolute', inset: 0, backgroundImage: 'linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)', backgroundSize: '60px 60px', maskImage: 'radial-gradient(ellipse at center, black 30%, transparent 70%)' }} />

      <div style={{ position: 'relative', zIndex: 1, width: '100%', maxWidth: 440, margin: '0 1rem' }}>
        {/* Logo + branding */}
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 72, height: 72, borderRadius: 20, background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.15), rgba(34, 197, 94, 0.05))', border: '1px solid rgba(34, 197, 94, 0.2)', marginBottom: '1.25rem', boxShadow: '0 0 40px rgba(34, 197, 94, 0.1)' }}>
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22V8" />
              <path d="M5 12H2a10 10 0 0020 0h-3" />
              <path d="M8 5.2C10 3 12 2 12 2s2 1 4 3.2" />
              <path d="M12 8c-2-2-4-2.5-4-2.5S8 8 12 8z" />
              <path d="M12 8c2-2 4-2.5 4-2.5S16 8 12 8z" />
            </svg>
          </div>
          <h1 style={{ color: '#f1f5f9', fontSize: '1.75rem', fontWeight: 800, letterSpacing: '-0.02em', marginBottom: '0.25rem' }}>
            Farm<span style={{ color: '#22c55e' }}>Buddy</span>
          </h1>
          <p style={{ color: '#475569', fontSize: '0.8rem', fontWeight: 500, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Admin Dashboard</p>
        </div>

        {/* Card */}
        <div style={{ padding: '2rem', borderRadius: '1.25rem', background: 'linear-gradient(180deg, rgba(15, 23, 42, 0.9), rgba(15, 23, 42, 0.7))', border: '1px solid rgba(148, 163, 184, 0.08)', backdropFilter: 'blur(20px)', boxShadow: '0 25px 50px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.03)' }}>
          <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
            <h2 style={{ color: '#e2e8f0', fontSize: '1.1rem', fontWeight: 600, marginBottom: '0.5rem' }}>Dobrodošlica natrag</h2>
            <p style={{ color: '#64748b', fontSize: '0.85rem', lineHeight: 1.5 }}>Prijavi se putem Discorda za pristup upravljačkoj ploči.</p>
          </div>

          {error && (
            <div style={{ marginBottom: '1.25rem', padding: '0.75rem 1rem', background: 'rgba(239, 68, 68, 0.08)', borderRadius: '0.75rem', border: '1px solid rgba(239, 68, 68, 0.15)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ color: '#ef4444', fontSize: '1rem' }}>⚠</span>
                <p style={{ color: '#fca5a5', fontSize: '0.825rem', margin: 0 }}>{errorMessages[error] || error}</p>
              </div>
              {debugRoles && (
                <p style={{ color: '#94a3b8', fontSize: '0.7rem', margin: 0, fontFamily: 'monospace' }}>Pronađene role: {debugRoles}</p>
              )}
            </div>
          )}

          <a href="/api/auth/discord" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.625rem', padding: '0.875rem 1.5rem', background: '#5865F2', color: '#fff', borderRadius: '0.75rem', textDecoration: 'none', fontWeight: 600, fontSize: '0.95rem', transition: 'all 0.2s', boxShadow: '0 4px 12px rgba(88, 101, 242, 0.3)', width: '100%', boxSizing: 'border-box' }}
            onMouseOver={e => { e.currentTarget.style.background = '#4752C4'; e.currentTarget.style.boxShadow = '0 6px 20px rgba(88, 101, 242, 0.4)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseOut={e => { e.currentTarget.style.background = '#5865F2'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(88, 101, 242, 0.3)'; e.currentTarget.style.transform = 'translateY(0)'; }}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 00-4.885-1.515.074.074 0 00-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 00-5.487 0 12.64 12.64 0 00-.617-1.25.077.077 0 00-.079-.037A19.736 19.736 0 003.677 4.37a.07.07 0 00-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 00.031.057 19.9 19.9 0 005.993 3.03.078.078 0 00.084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 00-.041-.106 13.107 13.107 0 01-1.872-.892.077.077 0 01-.008-.128 10.2 10.2 0 00.372-.292.074.074 0 01.077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 01.078.01c.12.098.246.198.373.292a.077.077 0 01-.006.127 12.299 12.299 0 01-1.873.892.077.077 0 00-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 00.084.028 19.839 19.839 0 006.002-3.03.077.077 0 00.032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 00-.031-.03z"/></svg>
            Nastavi s Discordom
          </a>

          <div style={{ marginTop: '1.5rem', paddingTop: '1.25rem', borderTop: '1px solid rgba(148, 163, 184, 0.06)' }}>
            <p style={{ color: '#475569', fontSize: '0.75rem', textAlign: 'center', margin: 0 }}>Pristup ograničen na:</p>
            <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginTop: '0.75rem' }}>
              {[
                { icon: '👑', name: 'Gazda', color: '#fbbf24' },
                { icon: '🏡', name: 'Sugazda', color: '#60a5fa' },
                { icon: '🏠', name: 'Suvlasnik', color: '#60a5fa' },
                { icon: '👤', name: 'Vlasnik', color: '#c084fc' },
                { icon: '🚜', name: 'Upravitelj', color: '#34d399' },
              ].map(role => (
                <div key={role.name} style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', padding: '0.35rem 0.65rem', background: 'rgba(255,255,255,0.03)', borderRadius: '0.5rem', border: '1px solid rgba(255,255,255,0.04)' }}>
                  <span style={{ fontSize: '0.8rem' }}>{role.icon}</span>
                  <span style={{ color: role.color, fontSize: '0.7rem', fontWeight: 600 }}>{role.name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <p style={{ textAlign: 'center', color: '#334155', fontSize: '0.7rem', marginTop: '1.5rem' }}>
          Slavonska Ravnica · Farming Simulator 25
        </p>
      </div>
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const { data: user, isLoading, error } = useQuery({
    queryKey: ['/api/auth/me'],
    queryFn: async () => {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      if (res.status === 401) return null;
      if (!res.ok) throw new Error('Auth check failed');
      return res.json();
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // Check URL for error param
  const urlParams = new URLSearchParams(window.location.search);
  const authError = urlParams.get('error');
  const debugRoles = urlParams.get('roles');

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
        <div style={{ textAlign: 'center', color: '#94a3b8' }}>
          <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>🌾</div>
          <p>Učitavanje...</p>
        </div>
      </div>
    );
  }

  if (!user || authError) {
    return <LoginScreen error={authError || undefined} debugRoles={debugRoles || undefined} />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/deploy" component={DeployPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <ErrorBoundary>
          <AuthGate>
            <Router />
            <AiChat />
          </AuthGate>
        </ErrorBoundary>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
