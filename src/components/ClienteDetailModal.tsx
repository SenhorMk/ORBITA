'use client';

import { useState } from "react";
import {
  User,
  Mail,
  FileText,
  CheckCircle2,
  MessageCircle,
  Copy
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { GlassModal } from '@/components/ui/glass-modal';
import type { Cliente } from '@/types';

interface ClienteDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  cliente: Cliente | null;
  onOpenChatwoot?: (phone?: string, name?: string) => void;
  onEdit?: (cliente: Cliente) => void;
  onDelete?: (id: string, blingId?: string) => void;
}

export function ClienteDetailModal({
  isOpen,
  onClose,
  cliente,
  onOpenChatwoot,
  onEdit,
  onDelete
}: ClienteDetailModalProps) {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const handleCopy = (text: string, field: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  return (
    <>
      {cliente && (
        <GlassModal
          isOpen={isOpen}
          onClose={onClose}
          title={
            <div className="flex items-center gap-2">
              {cliente.nome}
              {cliente.bling_id && (
                <Badge variant="outline" className="text-[10px] bg-white/5 border-emerald-500/30 text-emerald-400">
                  Bling OK
                </Badge>
              )}
            </div>
          }
          subtitle="Detalhes do Cliente"
          icon={<User className="w-6 h-6 text-blue-400" />}
          footer={
            <>
              <div>
                {onDelete && (
                  <Button
                    variant="destructive"
                    onClick={() => {
                      if (confirm('Tem certeza que deseja excluir este contato no Bling e no sistema local? Essa ação não pode ser desfeita.')) {
                        onDelete(cliente.id!, cliente.bling_id);
                      }
                    }}
                    className="bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white border border-red-500/30 rounded-xl"
                  >
                    Excluir
                  </Button>
                )}
              </div>
              <div className="flex gap-2">
                {onEdit && (
                  <Button
                    onClick={() => onEdit(cliente)}
                    className="glass-button-primary gap-2 rounded-xl"
                  >
                    Editar Contato
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={onClose}
                  className="bg-white/5 border-white/15 text-slate-300 hover:bg-white/10 rounded-xl"
                >
                  Fechar
                </Button>
              </div>
            </>
          }
        >
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              <div className="p-4 rounded-2xl glass-card border border-white/10 bg-white/[0.02] space-y-4">
                <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2 mb-3">
                  <Mail className="w-4 h-4 text-cyan-400" /> Contato
                </h3>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">Telefone</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-white">{cliente.telefone || '-'}</span>
                      {cliente.telefone && (
                        <button onClick={() => handleCopy(cliente.telefone!, 'phone')} className="text-slate-500 hover:text-white transition">
                          {copiedField === 'phone' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">Email</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white truncate max-w-[150px]" title={cliente.email}>{cliente.email || '-'}</span>
                      {cliente.email && (
                        <button onClick={() => handleCopy(cliente.email!, 'email')} className="text-slate-500 hover:text-white transition">
                          {copiedField === 'email' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {onOpenChatwoot && cliente.telefone && (
                  <Button
                    onClick={() => {
                      onClose();
                      onOpenChatwoot(cliente.telefone, cliente.nome);
                    }}
                    className="w-full mt-2 bg-blue-600/20 hover:bg-blue-600/40 text-blue-300 border border-blue-500/30 text-xs font-bold rounded-xl"
                  >
                    <MessageCircle className="w-4 h-4 mr-2" />
                    Abrir no Chatwoot
                  </Button>
                )}
              </div>

              <div className="p-4 rounded-2xl glass-card border border-white/10 bg-white/[0.02] space-y-4">
                <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider flex items-center gap-2 mb-3">
                  <FileText className="w-4 h-4 text-purple-400" /> Documento & Endereço
                </h3>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">CPF/CNPJ</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-white">{cliente.cpf_cnpj || '-'}</span>
                      {cliente.cpf_cnpj && (
                        <button onClick={() => handleCopy(cliente.cpf_cnpj!, 'doc')} className="text-slate-500 hover:text-white transition">
                          {copiedField === 'doc' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">Endereço</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-white truncate max-w-[150px]">
                        {[cliente.endereco, cliente.numero, cliente.bairro, cliente.cidade, cliente.uf].filter(Boolean).join(', ') || '-'}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-400">CEP</span>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-mono text-white">{cliente.cep || '-'}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </GlassModal>
      )}
    </>
  );
}
