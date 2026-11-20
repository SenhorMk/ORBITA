'use client';

import { useCallback, useEffect, useState } from 'react';
import { CreditCard, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HelpInfo } from '@/components/help/HelpInfo';

interface OrganizationEntitlements {
  plano_nome: string;
  plano_slug: 'starter' | 'pro' | 'enterprise';
  status: 'trial' | 'active' | 'past_due' | 'canceled' | 'incomplete';
  limite_membros: number;
  limite_conexoes_bling: number;
  limite_conexoes_chatwoot: number;
  periodo_fim: string | null;
}

export interface BillingPanelProps {
  /** Authenticated fetch boundary (Supabase bearer token attached by the caller). */
  fetchWithAuth: (url: string, options?: RequestInit) => Promise<Response>;
  /** Active organization id, resolved server-side elsewhere; never guessed on the client. */
  organizacaoId: string;
  /** Navigation seam so tests never trigger a real browser redirect. Defaults to `window.location.href`. */
  onRedirect?: (url: string) => void;
}

const UPGRADE_TARGETS: ReadonlyArray<{ slug: 'pro' | 'enterprise'; label: string }> = [
  { slug: 'pro', label: 'Pro' },
  { slug: 'enterprise', label: 'Enterprise' },
];

/**
 * Plano/limites e billing: reflete só o que
 * `/api/organizacoes/[id]/entitlements` confirmou e delega checkout/portal
 * para as rotas Stripe. Nenhum estado de assinatura é calculado no cliente.
 */
export function BillingPanel({ fetchWithAuth, organizacaoId, onRedirect }: BillingPanelProps) {
  const redirect = onRedirect ?? ((url: string) => { window.location.href = url; });

  const [entitlements, setEntitlements] = useState<OrganizationEntitlements | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutLoadingSlug, setCheckoutLoadingSlug] = useState<string | null>(null);
  const [portalLoading, setPortalLoading] = useState(false);

  const loadEntitlements = useCallback(async () => {
    setIsLoading(true);
    try {
      const response = await fetchWithAuth(`/api/organizacoes/${organizacaoId}/entitlements`);
      const body = await response.json();
      if (response.ok) setEntitlements(body.entitlements ?? null);
    } finally {
      setIsLoading(false);
    }
  }, [fetchWithAuth, organizacaoId]);

  useEffect(() => {
    let isMounted = true;
    void (async () => {
      if (isMounted) await loadEntitlements();
    })();
    return () => {
      isMounted = false;
    };
  }, [loadEntitlements]);

  async function handleCheckout(planoSlug: 'pro' | 'enterprise') {
    setCheckoutLoadingSlug(planoSlug);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plano_slug: planoSlug, intervalo: 'monthly' }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Falha ao iniciar checkout Stripe');
        return;
      }
      redirect(body.url);
    } finally {
      setCheckoutLoadingSlug(null);
    }
  }

  async function handleOpenPortal() {
    setPortalLoading(true);
    setError(null);
    try {
      const response = await fetchWithAuth('/api/stripe/portal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Falha ao abrir o portal de faturamento');
        return;
      }
      redirect(body.url);
    } finally {
      setPortalLoading(false);
    }
  }

  return (
    <div className="space-y-6 text-slate-200">
      <div className="flex items-center gap-2">
        <CreditCard className="w-5 h-5 text-[#0A84FF]" />
        <h2 className="text-lg font-semibold text-white">Plano e faturamento</h2>
      <HelpInfo ajudaId="billing.plano" />
      <HelpInfo ajudaId="billing.limites" />
      </div>

      {error && (
        <div role="alert" className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl px-3 py-2">
          {error}
        </div>
      )}

      {isLoading || !entitlements ? (
        <div className="text-sm text-slate-400">Carregando plano…</div>
      ) : (
        <>
          <div className="rounded-xl border border-white/10 bg-white/5 p-3 space-y-1 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-white font-semibold">{entitlements.plano_nome}</span>
              <span className="text-xs text-slate-400">{entitlements.status}</span>
            </div>
            <p className="text-xs text-slate-400">Membros: até {entitlements.limite_membros}</p>
            <p className="text-xs text-slate-400">Conexões Bling: até {entitlements.limite_conexoes_bling}</p>
            <p className="text-xs text-slate-400">Conexões Chatwoot: até {entitlements.limite_conexoes_chatwoot}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            {UPGRADE_TARGETS.filter((target) => target.slug !== entitlements.plano_slug).map((target) => (
              <Button
                key={target.slug}
                type="button"
                size="sm"
                disabled={checkoutLoadingSlug === target.slug}
                onClick={() => handleCheckout(target.slug)}
              >
                {checkoutLoadingSlug === target.slug ? 'Abrindo checkout…' : `Assinar ${target.label}`}
              </Button>
            ))}
            <Button type="button" size="sm" variant="outline" disabled={portalLoading} onClick={handleOpenPortal}>
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              {portalLoading ? 'Abrindo portal…' : 'Abrir portal de faturamento'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
