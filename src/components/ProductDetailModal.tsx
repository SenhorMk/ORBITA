'use client';

import { useState, useEffect } from 'react';
import { CheckCircle2, Copy, Save } from "lucide-react";
import type { Produto, Cliente, Categoria } from '@/types';
import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { Pilula } from '@/components/ui/StatusPill';
import { ErrorLogModal } from './ErrorLogModal';
import { isProdutoSynced, validateProdutoForBling, sanitizeProductName } from '@/lib/utils';
import { supabase } from '@/lib/supabaseClient';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import {
  buildProdutoRequest,
  produtoFormatoSchema,
  produtoSituacaoSchema,
  produtoTipoSchema,
  type ProdutoFormato,
  type ProdutoRequest,
  type ProdutoSituacao,
  type ProdutoTipo,
} from '@/lib/config/produtoContract';
import { avisoDoBootstrap, carregarCategoriasDoProduto } from '@/components/produtos/bootstrapDeCategorias';
import { lerObrigatoriosDoBling } from '@/components/produtos/obrigatoriosDoBling';

/**
 * O detalhe e a edição de um produto, agora no `Modal` do Design System.
 *
 * A casca mudou; a lógica não. Continuam iguais os campos, o carregamento de
 * categorias por `/api/categorias/sync`, a validação para o Bling antes de
 * enviar (`validateProdutoForBling`), a sanitização do nome, o
 * `buildProdutoRequest`, o `POST /api/produtos/update`, a regra de só aceitar o
 * registro devolvido pelo servidor e o `ErrorLogModal` com o log completo
 * quando a chamada falha.
 *
 * **O que saiu:** o menu de "ações rápidas" do cabeçalho. Ele tinha cinco itens,
 * e nenhum fazia algo que o formulário já não fizesse: copiar o SKU é o botão
 * dentro do próprio campo, e os três de status apenas escreviam `A` ou `I` no
 * seletor de situação, que está logo abaixo. O quinto, "Sincronizar no Bling",
 * era um `alert()` — não sincronizava nada. Um menu de atalhos duplicados, com
 * um deles fingindo trabalho, não sobrevive a uma migração cuja regra é que a
 * tela diga a verdade.
 */

/**
 * Os obrigatórios do Bling com que o formulário ABRE.
 *
 * Três casos, e a diferença entre eles é quem tem autoridade sobre o valor:
 *
 * - produto novo: ninguém — padrão seguro;
 * - produto local ainda sem par no ERP: ninguém lá fora — padrão seguro, mas a
 *   `unidade` persistida, quando existe, é a resposta;
 * - produto já sincronizado: o ERP. Aqui não se preenche nada: `null` é
 *   "desconhecido", e é o que mantém o salvar bloqueado até a leitura
 *   autoritativa responder. Preencher com o padrão e salvar sobrescreveria no
 *   Bling o tipo, a situação e o formato que estavam lá.
 */
function obrigatoriosIniciais(produto: Produto | null): {
  tipo: ProdutoTipo | null;
  situacao: ProdutoSituacao | null;
  formato: ProdutoFormato | null;
  unidade: string;
} {
  const unidade = produto?.unidade?.trim() ? produto.unidade.trim().toUpperCase() : 'UN';

  if (produto && isProdutoSynced(produto.bling_id)) {
    return { tipo: null, situacao: null, formato: null, unidade };
  }

  return { tipo: 'P', situacao: 'A', formato: 'S', unidade };
}

interface ProductDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  produto: Produto | null;
  cliente?: Cliente | null;
  /**
   * O produto foi gravado com sucesso.
   *
   * É um SINAL, e não o registro: quem chama relê o catálogo da fonte
   * autoritativa. A versão anterior entregava aqui o `ProdutoPersistido` da
   * rota — outro contrato, com `blingId` em vez de `bling_id` e sem
   * `categoria_id` nem `unidade` — e a linha do catálogo era substituída por
   * ele. O produto gravado passava a aparecer como não sincronizado, sem
   * categoria e "faltando dados", enquanto o banco tinha tudo.
   */
  onSaved?: () => void;
  onOpenChatwoot?: (phone?: string, name?: string) => void;
}

type ProdutoUpdatePayload = ProdutoRequest;

/** Resultado do submit de `/api/produtos/update`, já com os campos que a UI precisa para reagir. */
type SubmitProdutoResult =
  | { readonly ok: true; readonly product: unknown }
  | {
      readonly ok: false;
      readonly errorMessage: string;
      readonly details: string;
      readonly logs: string[];
    };

/** Envia o payload de produto para a API de sincronização, autenticado com o JWT da sessão atual. */
async function submitProdutoUpdate(payload: ProdutoUpdatePayload): Promise<SubmitProdutoResult> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const res = await fetchWithAuth('/api/produtos/update', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: JSON.stringify(payload),
  });

  const resData = await res.json();

  if (!res.ok || !resData.success) {
    return {
      ok: false,
      errorMessage: resData.error || 'Erro ao processar sincronização.',
      details: resData.details || 'Verifique as credenciais OAuth do Bling v3 no botão "Conectar APIs".',
      logs: resData.logs || [`[${new Date().toISOString()}] HTTP Status: ${res.status}`],
    };
  }

  return { ok: true, product: resData.product || payload };
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

export function ProductDetailModal({
  isOpen,
  onClose,
  produto,
  onSaved,
}: ProductDetailModalProps) {
  // Form editable state
  const [nome, setNome] = useState(produto?.nome || '');
  const [codigo, setCodigo] = useState(produto?.codigo || (produto?.bling_id ? `BLING-${produto.bling_id}` : ''));
  const [preco, setPreco] = useState(produto?.preco !== undefined ? String(produto.preco) : '0.00');
  const [estoque, setEstoque] = useState(produto?.estoque !== undefined ? String(produto.estoque) : '0');
  const [categoriaId, setCategoriaId] = useState(produto?.categoria_id || '');
  const [categorias, setCategorias] = useState<Categoria[]>([]);
  /** O que dizer sobre as categorias quando não há categorias para escolher. */
  const [avisoDeCategorias, setAvisoDeCategorias] = useState<string | null>(null);

  // Obrigatórios do Bling. `null` significa DESCONHECIDO — e desconhecido não
  // é `P`/`A`/`S`: num produto que já existe no ERP, preencher com o padrão e
  // salvar sobrescreve lá o que estava.
  //
  // O valor inicial vem do MESMO cálculo que a sincronização de props usa. Sem
  // isso, o primeiro render de um produto sincronizado já nasceria com o padrão
  // — e o bloco de sincronização abaixo não roda no primeiro render.
  const [tipo, setTipo] = useState<ProdutoTipo | null>(obrigatoriosIniciais(produto).tipo);
  const [situacao, setSituacao] = useState<ProdutoSituacao | null>(obrigatoriosIniciais(produto).situacao);
  const [formato, setFormato] = useState<ProdutoFormato | null>(obrigatoriosIniciais(produto).formato);
  const [unidade, setUnidade] = useState(obrigatoriosIniciais(produto).unidade);
  /** O que dizer quando os obrigatórios do produto sincronizado não vieram. */
  const [avisoDeObrigatorios, setAvisoDeObrigatorios] = useState<string | null>(null);
  const [buscandoObrigatorios, setBuscandoObrigatorios] = useState(false);

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
      const iniciais = obrigatoriosIniciais(produto);
      setUnidade(iniciais.unidade);
      setTipo(iniciais.tipo);
      setSituacao(iniciais.situacao);
      setFormato(iniciais.formato);
      setAvisoDeObrigatorios(null);
      setCategoriaId(produto.categoria_id || '');
      setObservacao(`Produto sincronizado via API Bling ERP. ID Bling: ${produto.bling_id}.`);
    } else {
      setNome('');
      setCodigo('');
      setPreco('0.00');
      setEstoque('0');
      const iniciais = obrigatoriosIniciais(null);
      setTipo(iniciais.tipo);
      setSituacao(iniciais.situacao);
      setFormato(iniciais.formato);
      setUnidade(iniciais.unidade);
      setAvisoDeObrigatorios(null);
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
        // O aviso anterior sai de cena antes da nova tentativa. Fica aqui, e
        // não no corpo do efeito, porque escrever estado sincronamente ali é o
        // que a regra `set-state-in-effect` do projeto proíbe.
        setAvisoDeCategorias(null);
        // `GET /api/categorias/sync` só LISTA o catálogo local; quem vai ao
        // Bling é o `POST` da mesma rota. Com o catálogo vazio — que é o estado
        // real do staging — este efeito abria o seletor com "Sem categoria" e
        // mais nada, para sempre. `carregarCategoriasDoProduto` lê, e só busca
        // no ERP se não houver nada para ler.
        const resultado = await carregarCategoriasDoProduto(fetchWithAuth);
        if (!isMounted) return;
        if (resultado._tag === 'Carregadas') setCategorias(resultado.categorias);
        // O desfecho vai para a TELA. Antes terminava em `console.warn`, e
        // "não tem categoria", "não consegui ler" e "não consegui importar"
        // desenhavam exatamente o mesmo seletor vazio.
        setAvisoDeCategorias(avisoDoBootstrap(resultado));
      })();
    }
    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  const blingIdSincronizado = produto && isProdutoSynced(produto.bling_id) ? produto.bling_id : null;
  /**
   * Falta autoridade sobre algum obrigatório?
   *
   * Enquanto isto for verdade o formulário não deixa salvar: um `PUT` daqui
   * gravaria no ERP um valor que ninguém confirmou.
   */
  const obrigatoriosDesconhecidos = tipo === null || situacao === null || formato === null;

  useEffect(() => {
    let ativo = true;
    if (isOpen && blingIdSincronizado !== null) {
      void (async () => {
        setBuscandoObrigatorios(true);
        const lidos = await lerObrigatoriosDoBling(fetchWithAuth, blingIdSincronizado);
        if (!ativo) return;
        if (lidos === null) {
          // Sem valor autoritativo não se preenche nada: o salvar fica
          // bloqueado em vez de mandar um padrão fictício para o ERP.
          setAvisoDeObrigatorios(
            'Não foi possível ler tipo, situação e formato deste produto no Bling. '
            + 'Salvar está bloqueado para não sobrescrever esses campos no ERP com valores padrão.',
          );
        } else {
          setTipo(lidos.tipo);
          setSituacao(lidos.situacao);
          setFormato(lidos.formato);
          setUnidade(lidos.unidade.toUpperCase());
          setAvisoDeObrigatorios(null);
        }
        setBuscandoObrigatorios(false);
      })();
    }
    return () => { ativo = false; };
  }, [isOpen, blingIdSincronizado]);

  if (!isOpen) return null;

  const handleCopyCode = () => {
    if (codigo) {
      navigator.clipboard.writeText(codigo);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  /** Erros de validação local, já no formato do modal de log. */
  const validarAntesDeEnviar = () => {
    // Sem autoridade sobre os obrigatórios não há envio. O botão já fica
    // desabilitado; esta guarda existe porque o caminho que escreve no ERP não
    // pode depender só da UI.
    if (tipo === null || situacao === null || formato === null) {
      return {
        isOpen: true,
        title: 'Obrigatórios do Bling desconhecidos',
        errorMessage:
          'Tipo, situação e formato deste produto ainda não foram lidos do Bling. '
          + 'Salvar agora sobrescreveria esses campos no ERP com valores padrão.',
      };
    }

    const validation = validateProdutoForBling({ nome, preco, estoque, codigo, tipo, situacao, formato, unidade });
    if (validation.valid) return null;
    return {
      isOpen: true,
      title: 'Validação de Dados para o Bling ERP',
      errorMessage: `${validation.errors.length} erro(s) encontrado(s). Corrija antes de sincronizar.`,
      details: validation.errors.join('\n'),
      logs: validation.errors.map((e, i) => `[${new Date().toISOString()}] ❌ Erro ${i + 1}: ${e}`),
    };
  };

  const handleSave = async () => {
    const erroDeValidacao = validarAntesDeEnviar();
    if (erroDeValidacao) {
      setErrorLogData(erroDeValidacao);
      return;
    }

    // Sanitizar nome automaticamente
    const nomeSanitizado = sanitizeProductName(nome);

    setIsSaving(true);
    setSavedSuccess(false);

    try {
      // Montado pelo contrato compartilhado com a rota: uma divergência de
      // forma falha aqui, antes da requisição, em vez de virar um `as` no
      // servidor. O SKU só é enviado quando o usuário informou um — nem o
      // modal nem o adapter inventam código.
      // Os obrigatórios já foram exigidos por `validarAntesDeEnviar`; repetir a
      // conferência aqui é o que impede um `PUT` com valor não confirmado caso
      // este caminho passe a ser chamado de outro lugar.
      if (tipo === null || situacao === null || formato === null) {
        setIsSaving(false);
        return;
      }

      const payload = buildProdutoRequest({
        id: produto?.id,
        blingId: /^\d+$/.test(String(produto?.bling_id ?? '')) ? String(produto?.bling_id) : undefined,
        nome: nomeSanitizado,
        codigo: codigo.trim() ? codigo.trim() : undefined,
        preco: parseFloat(preco) || 0,
        estoque: parseInt(estoque, 10) || 0,
        tipo,
        situacao,
        formato,
        unidade,
        categoriaId: categoriaId || undefined,
      });

      const result = await submitProdutoUpdate(payload);

      if (!result.ok) {
        // Exibir Modal com LOG Completo de Erro!
        setErrorLogData({
          isOpen: true,
          title: isNew ? 'Falha ao Cadastrar Produto (Bling / Supabase)' : 'Falha ao Atualizar Produto',
          errorMessage: result.errorMessage,
          details: result.details,
          logs: result.logs,
        });
        setIsSaving(false);
        return;
      }

      // Nada de devolver o registro: os dois contratos têm formas diferentes, e
      // converter um no outro por `as` é como a linha do catálogo perdia
      // `bling_id`, `categoria_id` e `unidade`. Quem chama relê.
      onSaved?.();

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

  // As mesmas três faixas de saldo da tabela do catálogo.
  const saldo = parseInt(estoque, 10);
  const saldoRotulo = saldo <= 0 ? 'Sem estoque' : saldo < 5 ? 'Estoque baixo' : 'Em estoque';
  const saldoCor = saldo <= 0 ? 'var(--danger)' : saldo < 5 ? 'var(--warning)' : 'var(--accent)';

  return (
    <>
      <Modal
        aberto={isOpen}
        onAbertoChange={(aberto) => {
          if (!aberto) onClose();
        }}
        tamanho="lg"
        eyebrow={
          isNew
            ? 'Novo produto'
            : `SKU ${codigo || '—'}${produto?.bling_id ? ` · ID Bling ${produto.bling_id}` : ''}`
        }
        titulo={nome || (isNew ? 'Cadastrar produto' : 'Produto sem nome')}
        descricao="Os dados do produto, sincronizados com o Bling ERP ao salvar."
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
                disabled={isSaving || obrigatoriosDesconhecidos}
                className="orbita-chip cursor-pointer"
                style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
              >
                <Save className="w-3.5 h-3.5" />
                {isSaving ? 'Salvando…' : 'Salvar alterações'}
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
              Alterações salvas.
            </output>
          )}

          <Pilula rotulo={saldoRotulo} cor={saldoCor} />

          <Secao titulo="Catálogo">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1.5 md:col-span-2">
                <Rotulo para="product-detail-nome">Nome do produto</Rotulo>
                <input
                  id="product-detail-nome"
                  type="text"
                  value={nome}
                  onChange={(e) => setNome(e.target.value)}
                  className="orbita-campo"
                  placeholder="Ex: Camiseta Oversized Streetwear"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-codigo">Código SKU / Ref. Bling</Rotulo>
                <div className="relative">
                  <input
                    id="product-detail-codigo"
                    type="text"
                    value={codigo}
                    onChange={(e) => setCodigo(e.target.value)}
                    className="orbita-campo orbita-campo--mono"
                    style={{ paddingRight: 38 }}
                    placeholder="Ex: CAM-001"
                  />
                  <button
                    type="button"
                    onClick={handleCopyCode}
                    title="Copiar código"
                    aria-label="Copiar código SKU"
                    className="absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer"
                    style={{ color: isCopied ? 'var(--accent)' : 'var(--txt3)' }}
                  >
                    {isCopied ? <CheckCircle2 className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-categoria">Categoria do produto</Rotulo>
                <select
                  id="product-detail-categoria"
                  value={categoriaId}
                  onChange={(e) => setCategoriaId(e.target.value)}
                  className="orbita-campo"
                >
                  <option value="">Sem categoria</option>
                  {categorias.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.descricao}</option>
                  ))}
                </select>
                {avisoDeCategorias !== null && (
                  <output className="text-[11px]" style={{ color: 'var(--warning)' }}>
                    {avisoDeCategorias}
                  </output>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-preco">Preço de venda (R$)</Rotulo>
                <input
                  id="product-detail-preco"
                  type="number"
                  step="0.01"
                  value={preco}
                  onChange={(e) => setPreco(e.target.value)}
                  className="orbita-campo orbita-campo--mono"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-estoque">Estoque atual (unidades)</Rotulo>
                <input
                  id="product-detail-estoque"
                  type="number"
                  value={estoque}
                  onChange={(e) => setEstoque(e.target.value)}
                  className="orbita-campo orbita-campo--mono"
                />
              </div>
            </div>
          </Secao>

          <Secao titulo="Obrigatórios do Bling">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-tipo">Tipo *</Rotulo>
                <select id="product-detail-tipo" value={tipo ?? ''} disabled={obrigatoriosDesconhecidos} onChange={(e) => setTipo(produtoTipoSchema.parse(e.target.value))} className="orbita-campo">
                  {tipo === null && <option value="">{buscandoObrigatorios ? 'Lendo do Bling…' : '—'}</option>}
                  <option value="P">Produto (P)</option>
                  <option value="S">Serviço (S)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-situacao">Situação *</Rotulo>
                <select id="product-detail-situacao" value={situacao ?? ''} disabled={obrigatoriosDesconhecidos} onChange={(e) => setSituacao(produtoSituacaoSchema.parse(e.target.value))} className="orbita-campo">
                  {situacao === null && <option value="">{buscandoObrigatorios ? 'Lendo do Bling…' : '—'}</option>}
                  <option value="A">Ativo (A)</option>
                  <option value="I">Inativo (I)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-formato">Formato *</Rotulo>
                <select id="product-detail-formato" value={formato ?? ''} disabled={obrigatoriosDesconhecidos} onChange={(e) => setFormato(produtoFormatoSchema.parse(e.target.value))} className="orbita-campo">
                  {formato === null && <option value="">{buscandoObrigatorios ? 'Lendo do Bling…' : '—'}</option>}
                  <option value="S">Simples (S)</option>
                  <option value="V">Variações (V)</option>
                  <option value="E">Composição (E)</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Rotulo para="product-detail-unidade">Unidade *</Rotulo>
                <input id="product-detail-unidade" type="text" value={unidade} onChange={(e) => setUnidade(e.target.value.toUpperCase())} maxLength={6} className="orbita-campo orbita-campo--mono" placeholder="UN, CX, KG" />
              </div>
            </div>
            {avisoDeObrigatorios !== null && (
              <output className="text-[11px]" style={{ color: 'var(--warning)' }}>
                {avisoDeObrigatorios}
              </output>
            )}
          </Secao>

          <Secao titulo="Observações">
            <textarea
              id="product-detail-observacao"
              aria-label="Observações e detalhes adicionais"
              rows={3}
              value={observacao}
              onChange={(e) => setObservacao(e.target.value)}
              className="orbita-campo"
              placeholder="Adicione notas internas sobre este produto..."
            />
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
        onRetry={handleSave}
      />
    </>
  );
}
