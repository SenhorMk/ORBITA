'use client';

import { useState } from "react";
import {
  User,
  Mail,
  Phone,
  FileText,
  MapPin,
  Save,
  CheckCircle2,
} from "lucide-react";
import type { Cliente } from '@/types';
import { GlassModal } from '@/components/ui/glass-modal';
import { supabase } from '@/lib/supabaseClient';
import { buildClienteRequest, contatoTipoSchema, indicadorIeSchema } from '@/lib/config/clienteContract';
import { ErrorLogModal } from './ErrorLogModal';
import { Button } from '@/components/ui/button';

interface ClienteEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  cliente: Cliente | null;
  onSave?: (updatedCliente: Cliente) => void;
}

export function ClienteEditModal({
  isOpen,
  onClose,
  cliente,
  onSave,
}: ClienteEditModalProps) {
  const isNew = !cliente;

  // Form State
  const [nome, setNome] = useState(cliente?.nome || '');
  const [email, setEmail] = useState(cliente?.email || '');
  const [telefone, setTelefone] = useState(cliente?.telefone || '');
  const [cpfCnpj, setCpfCnpj] = useState(cliente?.cpf_cnpj || '');

  // Extra fields for Bling
  const [tipo, setTipo] = useState(cliente?.tipo || 'F');
  const [contribuinte, setContribuinte] = useState(cliente?.indicador_ie !== undefined ? String(cliente.indicador_ie) : '9');
  const [cep, setCep] = useState(cliente?.cep || '');
  const [endereco, setEndereco] = useState(cliente?.endereco || '');
  const [numero, setNumero] = useState(cliente?.numero || '');
  const [bairro, setBairro] = useState(cliente?.bairro || '');
  const [cidade, setCidade] = useState(cliente?.cidade || '');
  const [uf, setUf] = useState(cliente?.uf || '');

  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [errors, setErrors] = useState<{ [key: string]: string }>({});

  const [prevCliente, setPrevCliente] = useState<Cliente | null>(cliente);
  const [prevOpen, setPrevOpen] = useState(isOpen);

  if (isOpen !== prevOpen || cliente !== prevCliente) {
    setPrevOpen(isOpen);
    setPrevCliente(cliente);
    if (cliente) {
      setNome(cliente.nome || '');
      setEmail(cliente.email || '');
      setTelefone(cliente.telefone || '');
      setCpfCnpj(cliente.cpf_cnpj || '');
      setTipo(cliente.tipo || 'F');
      setContribuinte(cliente.indicador_ie !== undefined ? String(cliente.indicador_ie) : '9');
      setCep(cliente.cep || '');
      setEndereco(cliente.endereco || '');
      setNumero(cliente.numero || '');
      setBairro(cliente.bairro || '');
      setCidade(cliente.cidade || '');
      setUf(cliente.uf || '');
    } else {
      setNome('');
      setEmail('');
      setTelefone('');
      setCpfCnpj('');
      setTipo('F');
      setContribuinte('9');
      setCep('');
      setEndereco('');
      setNumero('');
      setBairro('');
      setCidade('');
      setUf('');
    }
  }

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

  // Inferência automática baseada no tamanho do documento (opcional para melhorar UX)
  const handleDocChange = (val: string) => {
    setCpfCnpj(val);
    const digits = val.replace(/\D/g, '');
    if (digits.length === 14) {
      setTipo('J');
      setContribuinte('1');
    } else if (digits.length === 11) {
      setTipo('F');
      setContribuinte('9');
    }
  };

  const handleSave = async () => {
    const newErrors: { [key: string]: string } = {};

    if (!nome.trim()) {
      newErrors.nome = 'Campo obrigatório';
    }

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setErrors({});
    setIsSaving(true);
    setSavedSuccess(false);

    try {
      // Montado pelo contrato compartilhado com a rota. `indicadorIe` é o
      // nome real do campo no Bling — o antigo `contribuinte` não existe no
      // schema oficial e era descartado em silêncio pelo provedor.
      const payload = buildClienteRequest({
        id: cliente?.id,
        blingId: /^\d+$/.test(String(cliente?.bling_id ?? '')) ? String(cliente?.bling_id) : undefined,
        nome: nome.trim(),
        email: email.trim(),
        telefone: telefone.trim(),
        cpfCnpj: cpfCnpj.trim(),
        tipo: contatoTipoSchema.parse(tipo),
        indicadorIe: indicadorIeSchema.parse(parseInt(contribuinte, 10)),
        cep: cep.trim(),
        endereco: endereco.trim(),
        numero: numero.trim(),
        bairro: bairro.trim(),
        cidade: cidade.trim(),
        uf: uf.trim().toUpperCase(),
      });

      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;

      const res = await fetch('/api/clientes/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload),
      });

      const resData = await res.json();

      if (!res.ok || !resData.success) {
        setErrorLogData({
          isOpen: true,
          title: isNew ? 'Falha ao Cadastrar Contato' : 'Falha ao Atualizar Contato',
          errorMessage: resData.error || 'Erro ao processar sincronização.',
          details: resData.details || '',
          logs: resData.logs || [`[${new Date().toISOString()}] HTTP Status: ${res.status}`],
        });
        setIsSaving(false);
        return;
      }

      if (onSave && resData.client) {
        // Só o registro devolvido pelo servidor: ele carrega o id real do
        // Bling. Sobrescrever com o payload local mascarava uma sincronização
        // que podia não ter acontecido.
        onSave(resData.client);
      }

      setIsSaving(false);
      setSavedSuccess(true);
      setTimeout(() => {
        setSavedSuccess(false);
        onClose();
      }, 1500);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : 'Falha ao enviar dados.';
      setErrorLogData({
        isOpen: true,
        title: 'Erro de Execução (Node.js)',
        errorMessage: errMsg,
        details: String(err),
      });
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="relative z-40">
        <GlassModal
          isOpen={isOpen}
        onClose={onClose}
        title={isNew ? 'Cadastrar Novo Contato' : 'Editar Contato'}
        subtitle={isNew ? 'Sincronização em tempo real com Bling ERP' : `ID Bling: ${cliente?.bling_id}`}
        icon={<User className="w-6 h-6 text-blue-400" />}
        footer={
          <>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              {savedSuccess && (
                <span className="text-emerald-400 font-semibold flex items-center gap-1 animate-in fade-in">
                  <CheckCircle2 className="w-4 h-4" /> Salvo com sucesso!
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
                className="glass-button-primary gap-2 bg-blue-600/80 hover:bg-blue-600"
              >
                <Save className="w-4 h-4" />
                <span>{isSaving ? 'Salvando...' : 'Salvar Contato'}</span>
              </Button>
            </div>
          </>
        }
      >
        <div className="space-y-6">
                  {/* Dados Pessoais / Principais */}
                  <div>
                    <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider mb-4 flex items-center gap-2">
                      <User className="w-4 h-4 text-blue-400" /> Dados Principais
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="cliente-edit-nome" className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                          Nome / Razão Social *
                        </label>
                        <input
                          id="cliente-edit-nome"
                          type="text"
                          value={nome}
                          onChange={(e) => {
                            setNome(e.target.value);
                            if (errors.nome) setErrors(prev => ({ ...prev, nome: '' }));
                          }}
                          className={`w-full px-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-medium ${errors.nome ? 'border-rose-500/50 focus:border-rose-500 bg-rose-500/5' : ''}`}
                          placeholder="Ex: João da Silva / Empresa X"
                        />
                        {errors.nome && <span className="text-xs text-rose-400 font-semibold">{errors.nome}</span>}
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="cliente-edit-email" className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                          Email
                        </label>
                        <div className="relative">
                          <Mail className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
                          <input
                            id="cliente-edit-email"
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full pl-9 pr-4 py-2.5 rounded-2xl glass-input text-sm outline-none"
                            placeholder="contato@exemplo.com"
                          />
                        </div>
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="cliente-edit-telefone" className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                          Telefone / Celular
                        </label>
                        <div className="relative">
                          <Phone className="absolute left-3 top-3 w-4 h-4 text-slate-400" />
                          <input
                            id="cliente-edit-telefone"
                            type="text"
                            value={telefone}
                            onChange={(e) => setTelefone(e.target.value)}
                            className="w-full pl-9 pr-4 py-2.5 rounded-2xl glass-input text-sm outline-none font-mono"
                            placeholder="(11) 98765-4321"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Documento & Tributação (Bling) */}
                  <div className="p-5 rounded-2xl glass-card border border-white/10 bg-white/[0.02]">
                    <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider mb-4 flex items-center gap-2">
                      <FileText className="w-4 h-4 text-purple-400" /> Documento & Tributação
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="space-y-1.5">
                        <label htmlFor="cliente-edit-cpf-cnpj" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">
                          CPF / CNPJ
                        </label>
                        <input
                          id="cliente-edit-cpf-cnpj"
                          type="text"
                          value={cpfCnpj}
                          onChange={(e) => handleDocChange(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 focus:border-cyan-500/50 font-mono"
                          placeholder="000.000.000-00"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="cliente-edit-tipo" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">
                          Tipo de Pessoa *
                        </label>
                        <select
                          id="cliente-edit-tipo"
                          value={tipo}
                          onChange={(e) => setTipo(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 focus:border-cyan-500/50"
                        >
                          <option value="F">Física (F)</option>
                          <option value="J">Jurídica (J)</option>
                          <option value="E">Estrangeiro (E)</option>
                        </select>
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="cliente-edit-contribuinte" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">
                          Tipo de Contribuinte *
                        </label>
                        <select
                          id="cliente-edit-contribuinte"
                          value={contribuinte}
                          onChange={(e) => setContribuinte(e.target.value)}
                          className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 focus:border-cyan-500/50"
                        >
                          <option value="1">1 - Contribuinte ICMS</option>
                          <option value="2">2 - Contribuinte isento</option>
                          <option value="9">9 - Não contribuinte</option>
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Endereço */}
                  <div>
                    <h3 className="text-sm font-bold text-slate-200 uppercase tracking-wider mb-4 flex items-center gap-2">
                      <MapPin className="w-4 h-4 text-emerald-400" /> Endereço
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                      <div className="space-y-1.5">
                        <label htmlFor="cliente-edit-cep" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">CEP</label>
                        <input id="cliente-edit-cep" type="text" value={cep} onChange={e => setCep(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10" placeholder="00000-000" />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="cliente-edit-endereco" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Endereço / Rua</label>
                        <input id="cliente-edit-endereco" type="text" value={endereco} onChange={e => setEndereco(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10" placeholder="Rua Exemplo" />
                      </div>
                      <div className="space-y-1.5">
                        <label htmlFor="cliente-edit-numero" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Número</label>
                        <input id="cliente-edit-numero" type="text" value={numero} onChange={e => setNumero(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10" placeholder="123" />
                      </div>
                      <div className="space-y-1.5 md:col-span-2">
                        <label htmlFor="cliente-edit-bairro" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Bairro</label>
                        <input id="cliente-edit-bairro" type="text" value={bairro} onChange={e => setBairro(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10" placeholder="Centro" />
                      </div>
                      <div className="space-y-1.5 md:col-span-1">
                        <label htmlFor="cliente-edit-cidade" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">Cidade</label>
                        <input id="cliente-edit-cidade" type="text" value={cidade} onChange={e => setCidade(e.target.value)} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10" placeholder="São Paulo" />
                      </div>
                      <div className="space-y-1.5 md:col-span-1">
                        <label htmlFor="cliente-edit-uf" className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">UF</label>
                        <input id="cliente-edit-uf" type="text" value={uf} onChange={e => setUf(e.target.value)} maxLength={2} className="w-full px-3 py-2 rounded-xl glass-input text-xs outline-none bg-[#0B0E14] border-white/10 uppercase" placeholder="SP" />
                      </div>
                    </div>
                  </div>
        </div>
      </GlassModal>
      </div>

      <div className="relative z-50">
        <ErrorLogModal
          isOpen={errorLogData.isOpen}
          onClose={() => setErrorLogData(prev => ({ ...prev, isOpen: false }))}
          title={errorLogData.title}
          errorMessage={errorLogData.errorMessage}
          details={errorLogData.details}
          logs={errorLogData.logs}
          onRetry={handleSave}
        />
      </div>
    </>
  );
}
