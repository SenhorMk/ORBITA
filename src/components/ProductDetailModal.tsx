'use client';

import React, { useState, useEffect } from 'react';
import {
  Package,
  DollarSign,
  Box,
  Tag,
  FileText,
  MoreVertical,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Copy,
  Layers,
  Sparkles,
  Save,
} from "lucide-react";
import type { Produto, Cliente, Categoria } from '@/types';
import { GlassModal } from '@/components/ui/glass-modal';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuSeparator } from './ui/dropdown-menu';
import { ErrorLogModal } from './ErrorLogModal';
import { Button } from '@/components/ui/button';
import { validateProdutoForBling, sanitizeProductName } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';

interface ProductDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  produto: Produto | null;
  cliente?: Cliente | null;
  onSave?: (updatedProduto: Produto) => void;
  onOpenChatwoot?: (phone?: string, name?: string) => void;
}

export function ProductDetailModal({
  isOpen,
  onClose,
  produto,
  onSave,
}: ProductDetailModalProps) {
  // Form editable state
  const [nome, setNome] = useState(produto?.nome || '');
  const [codigo, setCodigo] = useState(produto?.codigo || (produto?.bling_id ? `BLING-${produto.bling_id}` : ''));
  const [preco, setPreco] = useState(produto?.preco !== undefined ? String(produto.preco) : '0.00');
  const [estoque, setEstoque] = useState(produto?.estoque !== undefined ? String(produto.estoque) : '0');
  const [categoriaId, setCategoriaId] = useState(produto?.categoria_id || '');
  const [categorias, setCategorias] = useState<Categoria[]>([]);

  // Bling mandatory fields
  const [tipo, setTipo] = useState('P');
  const [situacao, setSituacao] = useState('A');
  const [formato, setFormato] = useState('S');
  const [unidade, setUnidade] = useState('UN');

  const [observacao, setObservacao] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  const [prevProduto, setPrevProduto] = useState<Produto | null>(produto);
  const [prevOpen, setPrevOpen] = useState(isOpen);

  if (isOpen !== prevOpen || produto !== prevProduto) {
    setPrevOpen(isOpen);
    setPrevProduto(produto);
    if (produto) {
      setNome(produto.nome || '');
      setCodigo(produto.codigo || `BLING-${produto.bling_id}`);
      setPreco(produto.preco !== undefined ? String(produto.preco) : '0.00');
      setEstoque(produto.estoque !== undefined ? String(produto.estoque) : '0');
      setTipo('P');
      setSituacao('A');
      setFormato('S');
      setUnidade('UN');
      setCategoriaId(produto.categoria_id || '');
      setObservacao(`Produto sincronizado via API Bling ERP. ID Bling: ${produto.bling_id}.`);
    } else {
      setNome('');
      setCodigo('');
      setPreco('0.00');
      setEstoque('0');
      setTipo('P');
      setSituacao('A');
      setFormato('S');
      setUnidade('UN');
      setCategoriaId('');
      setObservacao('Novo produto a ser cadastrado simultaneamente no Bling ERP v3 e Supabase.');
    }
  }

  // Error Log Modal State
  const [errorLogData, setErrorLogData] = useState<{
    isOpen: boolean;
    title: string;
    errorMessage: string;
    details?: string;
    logs?: string[];
  }>({
    isOpen: false,
    title: '',
    errorMessage: '',
  });

  const isNew = !produto;

  useEffect(() => {
    let isMounted = true;
    if (isOpen) {
      void (async () => {
        try {
          const { data: { session } } = await supabase.auth.getSession();
          const token = session?.access_token;
          const res = await fetch('/api/categorias/sync', {
            headers: token ? { Authorization: `Bearer ${token}` } : {}
          });
          const data = (await res.json()) as { success?: boolean; data?: Categoria[] };
          if (isMounted && data.success && Array.isArray(data.data)) {
            setCategorias(data.data);
          }
        } catch (err) {
          console.warn('Erro ao buscar categorias:', err);
        }
      })();
    }
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCopyCode = () => {
    if (codigo) {
      navigator.clipboard.writeText(codigo);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const handleSave = async () => {
    // Validação completa antes de enviar ao Bling v3
    const validation = validateProdutoForBling({
      nome: nome,
      preco: preco,
      estoque: estoque,
      codigo: codigo,
      tipo: tipo,
      situacao: situacao,
      formato: formato,
      unidade: unidade,
    });

    if (!validation.valid) {
      setErrorLogData({
        isOpen: true,
        title: 'Validação de Dados para o Bling ERP',
        errorMessage: `${validation.errors.length} erro(s) encontrado(s). Corrija antes de sincronizar.`,
        details: validation.errors.join('\n'),
        logs: validation.errors.map((e, i) => `[${new Date().toISOString()}] ❌ Erro ${i + 1}: ${e}`),
      });
      return;
    }

    // Sanitizar nome automaticamente
    const nomeSanitizado = sanitizeProductName(nome);

    setIsSaving(true);
    setSavedSuccess(false);

    try {
      const payload: Partial<Produto> & { tipo?: string; situacao?: string; formato?: string; unidade?: string } = {
        id: produto?.id,
        bling_id: produto?.bling_id,
        nome: nomeSanitizado,
        codigo: codigo.trim(),
        preco: parseFloat(preco) || 0,
        estoque: parseInt(estoque, 10) || 0,
        tipo,
        situacao,
        formato,
        unidade,
        categoria_id: categoriaId || undefined,
      };

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/produtos/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload),
      });

      const resData = await res.json();

      if (!res.ok || !resData.success) {
        // Exibir Modal com LOG Completo de Erro!
        setErrorLogData({
          isOpen: true,
          title: isNew ? 'Falha ao Cadastrar Produto (Bling / Supabase)' : 'Falha ao Atualizar Produto',
          errorMessage: resData.error || 'Erro ao processar sincronização.',
          details: resData.details || 'Verifique as credenciais OAuth do Bling v3 no botão "Conectar APIs".',
          logs: resData.logs || [`[${new Date().toISOString()}] HTTP Status: ${res.status}`],
        });
        setIsSaving(false);
        return;
      }

      if (onSave) {
        onSave(resData.product || payload);
      }

      setIsSaving(false);
      setSavedSuccess(true);
      setTimeout(() => {
        setSavedSuccess(false);
        onClose();
      }, 1500);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Falha ao enviar dados de atualização.';
      setErrorLogData({
        isOpen: true,
        title: 'Erro de Execução (Node.js / Servidor)',
        errorMessage: errMsg,
        details: String(err),
        logs: [`[${new Date().toISOString()}] Exceção no cliente/fetch: ${errMsg}`],
      });
      setIsSaving(false);
    }
  };

  const statusColor =
    parseInt(estoque, 10) <= 0
      ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
      : parseInt(estoque, 10) < 5
      ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
      : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';

  const dropdownSections = [
    {
      title: 'Ações Rápidas',
      actions: [
        {
          id: 'copy-sku',
          label: isCopied ? 'SKU Copiado!' : 'Copiar Código SKU',
          icon: Copy,
          onClick: handleCopyCode,
        },
        {
          id: 'sync-bling',
          label: 'Sincronizar no Bling',
          icon: RefreshCw,
          onClick: () => alert(`Sincronizando ${nome || 'produto'} com o Bling ERP...`),
        },
      ],
    },
    {
      title: 'Status & Categoria',
      actions: [
        {
          id: 'set-active',
          label: 'Marcar como Ativo',
          icon: CheckCircle2,
          onClick: () => setSituacao('A'),
        },
        {
          id: 'set-production',
          label: 'Marcar em Produção',
          icon: Sparkles,
          onClick: () => setSituacao('A'),
        },
        {
          id: 'set-inactive',
          label: 'Inativar Produto',
          icon: AlertTriangle,
          danger: true,
          onClick: () => setSituacao('I'),
        },
      ],
    },
  ];

  return (
    <>
      <GlassModal
        isOpen={isOpen}
        onClose={onClose}
        title={nome || (isNew ? 'Cadastrar Novo Produto' : 'Produto Sem Nome')}
        subtitle={
          <div className="flex items-center gap-2">
            <span>SKU: <span className="text-cyan-300 font-semibold">{codigo || 'Será gerado no Bling'}</span></span>
            {!isNew && produto?.bling_id && <span>• ID Bling: {produto.bling_id}</span>}
            <span className={`ml-2 text-[10px] font-bold px-2.5 py-0.5 rounded-full border ${statusColor}`}>
              {parseInt(estoque, 10) <= 0 ? 'Sem Estoque' : parseInt(estoque, 10) < 5 ? 'Estoque Baixo' : 'Em Estoque'}
            </span>
          </div>
        }
        icon={
          produto?.imagem_url ? (
            <img
              src={produto.imagem_url}
              alt={nome || 'Novo Produto'}
              className="h-full w-full object-cover rounded-2xl"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <Package className="w-6 h-6 text-cyan-400" />
          )
        }
        headerActions={
          <DropdownMenu>
              <DropdownMenuTrigger asChild>

              <button className="p-2.5 rounded-2xl glass-card text-slate-300 hover:text-white hover:border-white/20 transition">
                <MoreVertical className="w-4 h-4" />
              </button>

              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 glass-panel border border-white/10 rounded-xl p-1 shadow-2xl bg-[#1A1A1A]">
                {dropdownSections.map((section, idx) => (
                  <React.Fragment key={idx}>
                    {idx > 0 && <DropdownMenuSeparator className="bg-white/10" />}
                    <DropdownMenuLabel className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                      {section.title}
                    </DropdownMenuLabel>
                    <DropdownMenuGroup>
                      {section.actions.map(action => {
                        const Icon = action.icon;
                        return (
                          <DropdownMenuItem
                            key={action.id}
                            onClick={action.onClick}
                            className={`cursor-pointer flex items-center gap-2 rounded-lg px-2 py-2 text-sm transition-colors ${action.danger ? 'text-rose-400 focus:bg-rose-500/20 focus:text-rose-300' : 'text-slate-200 focus:bg-white/10 focus:text-white'}`}
                          >
                            <Icon className="w-4 h-4" />
                            <span>{action.label}</span>
                          </DropdownMenuItem>
                        );
                      })}
                    </DropdownMenuGroup>
                  </React.Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
        }
        footer={
          <>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              {savedSuccess && (
                <span className="text-emerald-400 font-semibold flex items-center gap-1 animate-in fade-in">
                  <CheckCircle2 className="w-4 h-4" /> Alterações salvas!
                </span>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={onClose}
                className="bg-white/5 border-white/15 text-slate-300 hover:bg-white/10"
              >
                Cancelar
              </Button>

              <Button
                onClick={handleSave}
                disabled={isSaving}
                className="glass-button-primary gap-2"
              >
                <Save className="w-4 h-4" />
                <span>{isSaving ? 'Salvando...' : 'Salvar Alterações'}</span>
              </Button>
            </div>
          </>
        }
      >
        <div className="space-y-6">
                {/* Form Controls Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Nome do Produto */}
                  <div className="space-y-1.5 md:col-span-2">
                    <label className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Package className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Nome do Produto</span>
                    </label>
                    <input
                      type="text"
                      value={nome}
                      onChange={(e) => setNome(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium"
                      placeholder="Ex: Camiseta Oversized Streetwear"
                    />
                  </div>

                  {/* Código SKU */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Tag className="w-3.5 h-3.5 text-purple-400" />
                      <span>Código SKU / Ref. Bling</span>
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={codigo}
                        onChange={(e) => setCodigo(e.target.value)}
                        className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-mono"
                        placeholder="Ex: CAM-001"
                      />
                      <button
                        onClick={handleCopyCode}
                        className="absolute right-2.5 top-2.5 p-1 text-slate-400 hover:text-white"
                        title="Copiar Código"
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Categoria / Tag */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Layers className="w-3.5 h-3.5 text-amber-400" />
                      <span>Categoria do Produto</span>
                    </label>
                    <select
                      value={categoriaId}
                      onChange={(e) => setCategoriaId(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium bg-slate-900 text-slate-100 cursor-pointer"
                    >
                      <option value="">Sem categoria</option>
                      {categorias.map(cat => (
                        <option key={cat.id} value={cat.id}>{cat.descricao}</option>
                      ))}
                    </select>
                  </div>

                  {/* Preço de Venda */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Preço de Venda (R$)</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={preco}
                      onChange={(e) => setPreco(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-mono text-emerald-400 font-bold"
                    />
                  </div>

                  {/* Saldo de Estoque */}
                  <div className="space-y-1.5">
                    <label className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                      <Box className="w-3.5 h-3.5 text-indigo-400" />
                      <span>Estoque Atual (unidades)</span>
                    </label>
                    <input
                      type="number"
                      value={estoque}
                      onChange={(e) => setEstoque(e.target.value)}
                      className="w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-mono font-bold"
                    />
                  </div>
                </div>

                {/* Campos Obrigatórios Bling */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 p-5 rounded-2xl glass-card border border-white/10 bg-white/[0.02]">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Tipo *</label>
                    <select value={tipo} onChange={(e) => setTipo(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 focus:border-cyan-500/50">
                      <option value="P">Produto (P)</option>
                      <option value="S">Serviço (S)</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Situação *</label>
                    <select value={situacao} onChange={(e) => setSituacao(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 focus:border-cyan-500/50">
                      <option value="A">Ativo (A)</option>
                      <option value="I">Inativo (I)</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Formato *</label>
                    <select value={formato} onChange={(e) => setFormato(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 focus:border-cyan-500/50">
                      <option value="S">Simples (S)</option>
                      <option value="V">Variações (V)</option>
                      <option value="E">Composição (E)</option>
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Unidade (Ex: UN) *</label>
                    <input type="text" value={unidade} onChange={(e) => setUnidade(e.target.value.toUpperCase())} maxLength={6} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 focus:border-cyan-500/50 font-mono" placeholder="UN, CX, KG" />
                  </div>
                </div>

                {/* Observações / Descrição TextArea */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-slate-300 uppercase tracking-wider flex items-center gap-1.5">
                    <FileText className="w-3.5 h-3.5 text-cyan-400" />
                    <span>Observações & Detalhes Adicionais</span>
                  </label>
                  <textarea
                    rows={3}
                    value={observacao}
                    onChange={(e) => setObservacao(e.target.value)}
                    className="w-full p-4 rounded-2xl glass-input text-xs outline-none resize-none leading-relaxed"
                    placeholder="Adicione notas internas sobre este produto..."
                  />
                </div>
        </div>
      </GlassModal>
    <ErrorLogModal
      isOpen={errorLogData.isOpen}
      onClose={() => setErrorLogData(prev => ({ ...prev, isOpen: false }))}
      title={errorLogData.title}
      errorMessage={errorLogData.errorMessage}
      details={errorLogData.details}
      logs={errorLogData.logs}
      onRetry={handleSave}
    />
  </>
  );
}
