'use client';

import { useState } from "react";
import { CheckCircle2, Save } from "lucide-react";
import type { Cliente } from '@/types';
import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { supabase } from '@/lib/supabaseClient';
import { buildClienteRequest, contatoTipoSchema, indicadorIeSchema } from '@/lib/config/clienteContract';
import { ErrorLogModal } from './ErrorLogModal';
import { fetchWithAuth } from '@/lib/fetchWithAuth';

/**
 * O cadastro e a edição de um contato, agora no `Modal` do Design System.
 *
 * A casca mudou; a lógica não. São os mesmos campos do contrato de cliente — e
 * só eles —, a mesma inferência de tipo de pessoa e de indicador de IE pelo
 * tamanho do documento, a mesma validação de nome obrigatório, o mesmo
 * `buildClienteRequest`, o mesmo `POST /api/clientes/update`, a mesma regra de
 * só aceitar o registro devolvido pelo servidor, e o mesmo `ErrorLogModal`
 * quando a chamada falha.
 */

/** O que a resposta de falha de `POST /api/clientes/update` diz à tela. */
interface FalhaDoContato {
  readonly error?: string;
  readonly retrySafe?: boolean;
  readonly reconcileRequired?: boolean;
}

/**
 * A frase do desfecho ambíguo — quando o navegador não sabe o que aconteceu.
 *
 * Ela não afirma que o contato não foi criado, porque ninguém verificou. O
 * `fetch` pode ter rejeitado **depois** de o servidor receber o POST e o Bling
 * criar o contato: a resposta se perde, e o navegador cai no `catch` sem saber
 * de nada.
 */
const FALHA_AMBIGUA =
  'O envio não pôde ser confirmado. O contato pode ter sido criado no Bling. '
  + 'Sincronize os clientes e confira antes de tentar de novo.';

/**
 * O estado do diálogo quando o navegador não sabe o que aconteceu.
 *
 * Era aqui que estava o bloqueio da revisão externa. O `catch` de `handleSave`
 * afirmava que "nada foi confirmado por provedor nenhum, então repetir continua
 * sendo seguro" — e a premissa é falsa: o POST pode ter chegado ao servidor, o
 * Bling pode ter criado o contato, e só a resposta ter se perdido no caminho de
 * volta. Rede caindo, aborto e JSON ilegível são o mesmo estado — **não se
 * sabe** —, e repetir daqui cadastra um segundo contato no ERP.
 *
 * A mensagem técnica do erro também não vai para a tela: ela não diz nada
 * acionável sobre o efeito externo, que é justamente o que está em dúvida.
 */
function estadoAmbiguo() {
  return {
    isOpen: true,
    title: 'Resultado do envio não confirmado',
    errorMessage: FALHA_AMBIGUA,
    permiteRepetir: false,
  };
}

/**
 * Traduz a falha da rota no estado do diálogo de erro.
 *
 * `details` e `logs` NÃO vêm mais do corpo da resposta. Era por aí que a linha
 * recusada pelo Postgres — nome, e-mail e telefone do contato — chegava ao
 * diálogo na captura da revisão. O servidor deixou de mandar; a tela deixa de
 * pedir. O que sobra é o status HTTP, que é informação dela.
 *
 * **"Tentar novamente" exige prova, não ausência de má notícia.** O botão só
 * aparece com `retrySafe: true`, que é o servidor afirmando que nada foi
 * confirmado do outro lado. Antes a tela usava `reconcileRequired === false`
 * como sinônimo de seguro — e isso tratava "não sei o que houve" como "nada
 * houve", que é a premissa que duplica contato no ERP.
 */
function estadoDeFalhaDoContato(
  resposta: FalhaDoContato,
  status: number,
  isNew: boolean,
) {
  const precisaReconciliar = resposta.reconcileRequired === true;
  const permiteRepetir = resposta.retrySafe === true && !precisaReconciliar;
  return {
    isOpen: true,
    title: precisaReconciliar
      ? 'Contato criado no Bling, gravação local pendente'
      : permiteRepetir
        ? isNew
          ? 'Falha ao Cadastrar Contato'
          : 'Falha ao Atualizar Contato'
        : 'Resultado do envio não confirmado',
    errorMessage: resposta.error || (permiteRepetir ? 'Erro ao processar sincronização.' : FALHA_AMBIGUA),
    logs: [`[${new Date().toISOString()}] HTTP Status: ${status}`],
    permiteRepetir,
  };
}

interface ClienteEditModalProps {
  isOpen: boolean;
  onClose: () => void;
  cliente: Cliente | null;
  onSave?: (updatedCliente: Cliente) => void;
}

/** O rótulo de um campo — a mesma mono maiúscula do resto do produto. */
function Rotulo({ para, children }: { para: string; children: React.ReactNode }) {
  return (
    <label htmlFor={para} className="orbita-eyebrow">
      {children}
    </label>
  );
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h4 className="orbita-eyebrow">{titulo}</h4>
      {children}
    </section>
  );
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
    /**
     * Existe prova de que repetir é seguro?
     *
     * Fecha por omissão, e é isso que importa: só é `true` quando o servidor
     * **afirmou** `retrySafe`. Falha de transporte, JSON ilegível, 5xx do
     * provedor e commit conhecido no Bling caem todos no `false` — o navegador
     * não sabe se o contato foi criado, e um botão "tentar novamente" ali é um
     * convite a duplicar cadastro no ERP.
     */
    permiteRepetir?: boolean;
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

      const res = await fetchWithAuth('/api/clientes/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {})
        },
        body: JSON.stringify(payload),
      });

      const resData = await res.json();

      if (!res.ok || !resData.success) {
        setErrorLogData(estadoDeFalhaDoContato(resData, res.status, isNew));
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
    } catch {
      // Desfecho ambíguo. Ver `estadoAmbiguo`.
      setErrorLogData(estadoAmbiguo());
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <Modal
        aberto={isOpen}
        onAbertoChange={(aberto) => {
          if (!aberto) onClose();
        }}
        tamanho="lg"
        eyebrow={isNew ? 'Novo contato' : `ID Bling: ${cliente?.bling_id}`}
        titulo={isNew ? 'Cadastrar contato' : 'Editar contato'}
        descricao="Os dados do contato, sincronizados com o Bling ERP ao salvar."
        rodape={
          <RodapeDeModal
            secundaria={
              <button type="button" onClick={onClose} className="orbita-chip cursor-pointer">
                Cancelar
              </button>
            }
            primaria={
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="orbita-chip cursor-pointer"
                style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
              >
                <Save className="w-3.5 h-3.5" />
                {isSaving ? 'Salvando…' : 'Salvar contato'}
              </button>
            }
          />
        }
      >
        <div className="flex flex-col gap-6">
          {savedSuccess && (
            <output
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-semibold"
              style={{ background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--accent)' }}
            >
              <CheckCircle2 className="w-4 h-4" aria-hidden />
              Contato salvo.
            </output>
          )}

          <Secao titulo="Dados principais">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <Rotulo para="cliente-edit-nome">Nome / Razão social *</Rotulo>
                <input
                  id="cliente-edit-nome"
                  type="text"
                  value={nome}
                  aria-invalid={errors.nome ? true : undefined}
                  onChange={(e) => {
                    setNome(e.target.value);
                    if (errors.nome) setErrors(prev => ({ ...prev, nome: '' }));
                  }}
                  className="orbita-campo"
                  placeholder="Ex: João da Silva / Empresa X"
                />
                {errors.nome && (
                  <span className="text-xs font-semibold" style={{ color: 'var(--danger)' }}>{errors.nome}</span>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-email">E-mail</Rotulo>
                <input
                  id="cliente-edit-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="orbita-campo"
                  placeholder="contato@exemplo.com"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-telefone">Telefone / Celular</Rotulo>
                <input
                  id="cliente-edit-telefone"
                  type="text"
                  value={telefone}
                  onChange={(e) => setTelefone(e.target.value)}
                  className="orbita-campo orbita-campo--mono"
                  placeholder="(11) 98765-4321"
                />
              </div>
            </div>
          </Secao>

          <Secao titulo="Documento & tributação">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-cpf-cnpj">CPF / CNPJ</Rotulo>
                <input
                  id="cliente-edit-cpf-cnpj"
                  type="text"
                  value={cpfCnpj}
                  onChange={(e) => handleDocChange(e.target.value)}
                  className="orbita-campo orbita-campo--mono"
                  placeholder="000.000.000-00"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-tipo">Tipo de pessoa *</Rotulo>
                <select
                  id="cliente-edit-tipo"
                  value={tipo}
                  onChange={(e) => setTipo(e.target.value)}
                  className="orbita-campo"
                >
                  <option value="F">Física (F)</option>
                  <option value="J">Jurídica (J)</option>
                  <option value="E">Estrangeiro (E)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-contribuinte">Tipo de contribuinte *</Rotulo>
                <select
                  id="cliente-edit-contribuinte"
                  value={contribuinte}
                  onChange={(e) => setContribuinte(e.target.value)}
                  className="orbita-campo"
                >
                  <option value="1">1 - Contribuinte ICMS</option>
                  <option value="2">2 - Contribuinte isento</option>
                  <option value="9">9 - Não contribuinte</option>
                </select>
              </div>
            </div>
          </Secao>

          <Secao titulo="Endereço">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-cep">CEP</Rotulo>
                <input id="cliente-edit-cep" type="text" value={cep} onChange={e => setCep(e.target.value)} className="orbita-campo orbita-campo--mono" placeholder="00000-000" />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <Rotulo para="cliente-edit-endereco">Endereço / Rua</Rotulo>
                <input id="cliente-edit-endereco" type="text" value={endereco} onChange={e => setEndereco(e.target.value)} className="orbita-campo" placeholder="Rua Exemplo" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-numero">Número</Rotulo>
                <input id="cliente-edit-numero" type="text" value={numero} onChange={e => setNumero(e.target.value)} className="orbita-campo" placeholder="123" />
              </div>
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <Rotulo para="cliente-edit-bairro">Bairro</Rotulo>
                <input id="cliente-edit-bairro" type="text" value={bairro} onChange={e => setBairro(e.target.value)} className="orbita-campo" placeholder="Centro" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-cidade">Cidade</Rotulo>
                <input id="cliente-edit-cidade" type="text" value={cidade} onChange={e => setCidade(e.target.value)} className="orbita-campo" placeholder="São Paulo" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="cliente-edit-uf">UF</Rotulo>
                <input id="cliente-edit-uf" type="text" value={uf} onChange={e => setUf(e.target.value)} maxLength={2} className="orbita-campo uppercase" placeholder="SP" />
              </div>
            </div>
          </Secao>
        </div>
      </Modal>

      <ErrorLogModal
        isOpen={errorLogData.isOpen}
        onClose={() => setErrorLogData(prev => ({ ...prev, isOpen: false }))}
        title={errorLogData.title}
        errorMessage={errorLogData.errorMessage}
        details={errorLogData.details}
        logs={errorLogData.logs}
        // Sem `onRetry`, o `ErrorLogModal` não desenha o botão — e é essa a
        // decisão local que o ticket pediu, em vez de redesenhar um diálogo
        // usado por outras telas.
        //
        // A condição é **positiva**: só oferece repetir quem tem prova de que
        // repetir é seguro. `permiteRepetir` fecha por omissão, então qualquer
        // desfecho que o navegador não entendeu cai no lado sem botão.
        onRetry={errorLogData.permiteRepetir ? handleSave : undefined}
      />
    </>
  );
}
