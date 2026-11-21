'use client';

import { HelpContext } from '@/components/help/HelpContext';

import { useState } from "react";
import { motion, AnimatePresence } from 'framer-motion';
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AlertTriangle, X, Copy, Check, Terminal, ShieldAlert, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ErrorLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  errorMessage?: string;
  details?: string;
  logs?: string[];
  onRetry?: () => void;
}

export function ErrorLogModal({
  isOpen,
  onClose,
  title = 'Falha na Integração & Sincronização',
  errorMessage = 'Ocorreu um erro ao comunicar com os servidores.',
  details,
  logs = [],
  onRetry
}: ErrorLogModalProps) {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const fullLogText = [
    `=== LOG DE ERRO DE INTEGRAÇÃO (${new Date().toLocaleString('pt-BR')}) ===`,
    `TÍTULO: ${title}`,
    `MENSAGEM: ${errorMessage}`,
    details ? `DETALHES TÉCNICOS: ${details}` : '',
    logs.length > 0 ? `\nRASTROS E EXECUÇÃO DE LOGS:\n${logs.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const handleCopy = () => {
    navigator.clipboard.writeText(fullLogText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AnimatePresence>
        {isOpen && (
          <DialogPrimitive.Portal forceMount>
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6 overflow-hidden">
              {/* Backdrop Overlay */}
              <DialogPrimitive.Overlay asChild forceMount>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  onClick={onClose}
                  className="fixed inset-0 bg-black/85 backdrop-blur-xl"
                />
              </DialogPrimitive.Overlay>

              {/* Modal Panel */}
              <DialogPrimitive.Content asChild forceMount>
                <motion.div
                  initial={{ opacity: 0, scale: 0.95, y: 15 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.95, y: 15 }}
                  transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                  className="relative w-full max-w-2xl glass-panel border border-rose-500/30 rounded-3xl shadow-2xl overflow-hidden z-10 my-auto flex flex-col max-h-[85vh]"
                >
                  {/* Header Bar */}
                  <div className="p-5 border-b border-rose-500/20 bg-rose-500/10 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-2xl bg-rose-500/20 text-rose-400 border border-rose-500/30">
                        <ShieldAlert className="w-6 h-6 animate-pulse" />
                      </div>
                      <div>
                        <HelpContext ajudaId="diagnostico.erro">
                          <DialogPrimitive.Title className="text-base font-bold text-rose-200 m-0">{title}</DialogPrimitive.Title>
                        </HelpContext>
                        <p className="text-xs text-rose-400/80">Log de Diagnóstico do Node.js / Supabase / Bling</p>
                      </div>
                    </div>

                    <DialogPrimitive.Close asChild>
                      <button
                        onClick={onClose}
                        className="p-2 rounded-xl text-rose-300 hover:bg-rose-500/20 transition"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </DialogPrimitive.Close>
                  </div>

                  {/* Body Content */}
                  <div className="p-6 space-y-4 overflow-y-auto flex-1">
                    {/* Error Banner */}
                    <div className="p-4 rounded-2xl bg-rose-950/40 border border-rose-500/30 text-xs text-rose-200 space-y-2">
                      <div className="flex items-center gap-2 font-bold text-rose-300">
                        <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
                        <span>{errorMessage}</span>
                      </div>
                      {details && (
                        <p className="text-[11px] text-rose-300/90 font-mono bg-black/40 p-2.5 rounded-xl border border-rose-500/20 leading-relaxed">
                          {details}
                        </p>
                      )}
                    </div>

                    {/* Terminal Log Console */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                        <span className="font-bold flex items-center gap-1.5 text-slate-300">
                          <Terminal className="w-3.5 h-3.5 text-cyan-400" /> Console de Saída & Debugging
                        </span>
                        <button
                          onClick={handleCopy}
                          className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 font-semibold"
                        >
                          {copied ? (
                            <>
                              <Check className="w-3.5 h-3.5 text-emerald-400" /> Copiado!
                            </>
                          ) : (
                            <>
                              <Copy className="w-3.5 h-3.5" /> Copiar Logs
                            </>
                          )}
                        </button>
                      </div>

                      <pre className="p-4 rounded-2xl bg-black/90 text-rose-300 font-mono text-[11px] leading-relaxed border border-white/10 overflow-x-auto max-h-64 shadow-inner whitespace-pre-wrap">
                        {fullLogText}
                      </pre>
                    </div>
                  </div>

                  {/* Footer Bar */}
                  <div className="p-4 border-t border-white/10 bg-white/[0.02] flex items-center justify-end gap-3">
                    <Button
                      variant="outline"
                      onClick={onClose}
                      className="bg-white/5 border-white/15 text-slate-300 hover:bg-white/10 text-xs"
                    >
                      Fechar
                    </Button>

                    {onRetry && (
                      <Button
                        onClick={() => {
                          onClose();
                          onRetry();
                        }}
                        className="glass-button-primary gap-2 text-xs"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        <span>Tentar Novamente</span>
                      </Button>
                    )}
                  </div>
                </motion.div>
              </DialogPrimitive.Content>
            </div>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  );
}
