'use client';

import { useState } from "react";
import { Activity, Database, ShoppingBag, MessageCircle, CheckCircle, XCircle, RefreshCw } from 'lucide-react';

interface HealthMonitorProps {
  supabaseConnected?: boolean;
  blingConnected?: boolean;
  chatwootConnected?: boolean;
  onRefresh?: () => void;
}

export function HealthMonitor({
  supabaseConnected = true,
  blingConnected = true,
  chatwootConnected = true,
  onRefresh
}: HealthMonitorProps) {
  const [showTooltip, setShowTooltip] = useState(false);

  const allConnected = supabaseConnected && blingConnected && chatwootConnected;

  return (
    <div className="relative inline-block select-none">
      <div
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        className="flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-white/5 backdrop-blur-md border border-white/10 hover:border-white/20 transition-all cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span
              className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                allConnected ? 'bg-[#30D158]' : 'bg-[#FF9F0A]'
              }`}
            />
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                allConnected ? 'bg-[#30D158]' : 'bg-[#FF9F0A]'
              }`}
            />
          </span>

          <span className="text-xs text-slate-300 font-medium">
            {allConnected ? 'Sistemas Online' : 'Atenção APIs'}
          </span>
        </div>

        <div className="h-3 w-px bg-white/10" />

        {/* Status Icons Mini */}
        <div className="flex items-center gap-1.5 text-slate-400">
          <Database className={`w-3.5 h-3.5 ${supabaseConnected ? 'text-[#30D158]' : 'text-red-400'}`} />
          <ShoppingBag className={`w-3.5 h-3.5 ${blingConnected ? 'text-[#30D158]' : 'text-red-400'}`} />
          <MessageCircle className={`w-3.5 h-3.5 ${chatwootConnected ? 'text-[#30D158]' : 'text-red-400'}`} />
        </div>
      </div>

      {/* Popover / Tooltip iOS Style */}
      {showTooltip && (
        <div className="absolute left-0 mt-2 w-64 p-3.5 rounded-2xl glass-panel border border-white/15 shadow-2xl backdrop-blur-2xl z-50 space-y-2.5 text-xs animate-in fade-in duration-150">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span className="font-semibold text-white flex items-center gap-1.5">
              <Activity className="w-4 h-4 text-[#0A84FF]" /> Conexões Reais
            </span>
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="p-1 rounded text-slate-400 hover:text-white hover:bg-white/10"
                title="Atualizar Status"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            )}
          </div>

          <div className="space-y-2">
            {/* Supabase Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-300">
                <Database className="w-3.5 h-3.5 text-[#30D158]" />
                <span>Supabase Database</span>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-[#30D158]/15 text-[#30D158] border border-[#30D158]/30 flex items-center gap-1">
                <CheckCircle className="w-2.5 h-2.5" /> Ativo
              </span>
            </div>

            {/* Bling v3 Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-300">
                <ShoppingBag className="w-3.5 h-3.5 text-[#0A84FF]" />
                <span>ERP Bling v3</span>
              </div>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border flex items-center gap-1 ${
                  blingConnected
                    ? 'bg-[#30D158]/15 text-[#30D158] border-[#30D158]/30'
                    : 'bg-red-500/15 text-red-300 border-red-500/30'
                }`}
              >
                {blingConnected ? (
                  <>
                    <CheckCircle className="w-2.5 h-2.5" /> Conectado
                  </>
                ) : (
                  <>
                    <XCircle className="w-2.5 h-2.5" /> Requer API Key
                  </>
                )}
              </span>
            </div>

            {/* Chatwoot Status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-300">
                <MessageCircle className="w-3.5 h-3.5 text-green-400" />
                <span>Chatwoot WhatsApp</span>
              </div>
              <span
                className={`text-[10px] px-2 py-0.5 rounded-full font-semibold border flex items-center gap-1 ${
                  chatwootConnected
                    ? 'bg-[#30D158]/15 text-[#30D158] border-[#30D158]/30'
                    : 'bg-red-500/15 text-red-300 border-red-500/30'
                }`}
              >
                {chatwootConnected ? (
                  <>
                    <CheckCircle className="w-2.5 h-2.5" /> Webhook Ativo
                  </>
                ) : (
                  <>
                    <XCircle className="w-2.5 h-2.5" /> Desconectado
                  </>
                )}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
