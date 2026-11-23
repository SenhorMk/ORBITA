'use client';
import responsive from '@/components/ui/Responsive.module.css';
import { corDeTexto } from '@/components/ui/corDeTexto';

import { HelpContext, helpPageHeader } from '@/components/help/HelpContext';

import { useMemo, useState, type ReactNode } from 'react';
import { Package, Search } from 'lucide-react';

import type { Categoria, Produto } from '@/types';
import {
  AvisoDeAtualizacaoFalhada,
  EstadoCarregando,
  EstadoDeErro,
  EstadoVazio,
} from '@/components/ui/estados';
import { isProdutoSynced } from '@/lib/utils';
import { TabelaDeProdutos } from './TabelaDeProdutos';

/**
 * Estoque & Produtos, na linguagem do produto novo.
 *
 * Isto é reskin. Os quatro filtros são os mesmos de antes, com os mesmos
 * campos e o mesmo comportamento — busca por nome ou SKU, situação por saldo,
 * categoria e faixa de preço —, e o predicado abaixo é o que estava em
 * `page.tsx`, movido sem alteração.
 *
 * As duas listas separadas de antes (sincronizados em cima, não sincronizados
 * numa seção embaixo) viraram **uma** tabela com uma coluna de espelho do
 * Bling. O que a separação dizia continua dito: qual produto ainda não existe
 * no ERP, quantos são, o que falta em cada um e por que isso importa. O que
 * mudou é só onde a informação aparece.
 *
 * Carregando, vazio e erro são três coisas diferentes, e a distinção é a mesma
 * de Vendas: enquanto nenhuma leitura deu certo não existe lista para mostrar,
 * e uma leitura que falhou nunca vira "nenhum produto". Quando já houve leitura
 * boa e a atualização falha, o catálogo continua na tela com a ressalva.
 */

type SituacaoDeEstoque = 'all' | 'active' | 'inactive';

/** A lista de "ainda não carregou", com identidade estável para o `useMemo`. */
const SEM_PRODUTOS: readonly Produto[] = [];

const SITUACOES: ReadonlyArray<{ id: SituacaoDeEstoque; rotulo: string }> = [
  { id: 'all', rotulo: 'Todos' },
  { id: 'active', rotulo: 'Em estoque' },
  { id: 'inactive', rotulo: 'Sem estoque' },
];

function Resumo({ rotulo, valor, cor }: { rotulo: string; valor: number; cor: string }) {
  return (
    <div
      className="flex flex-col justify-between"
      style={{
        gap: 12,
        minHeight: 'var(--resumo-min)',
        padding: '12px 13px',
        borderRadius: 16,
        background: 'var(--glass2)',
        border: '1px solid var(--line)',
      }}
    >
      <span
        className="flex items-center"
        style={{ gap: 7, font: '400 10.5px/1.35 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: cor }} aria-hidden />
        {rotulo}
      </span>
      <span className="orbita-numero" style={{ fontSize: 'var(--resumo-fs)', color: corDeTexto(cor) }}>
        {valor}
      </span>
    </div>
  );
}

interface EstoqueEProdutosProps {
  /** Os produtos da última leitura boa, ou `null` se nenhuma leitura deu certo ainda. */
  produtos: readonly Produto[] | null;
  categorias: readonly Categoria[];
  carregando: boolean;
  /** A falha da leitura mais recente, se houve. */
  erroDeLeitura: string | null;
  onRecarregar: () => void;
  onAbrirProduto: (produto: Produto) => void;
  onCadastrarProduto: () => void;
  assistente?: ReactNode;
}

export function EstoqueEProdutos({
  produtos,
  categorias,
  carregando,
  erroDeLeitura,
  onRecarregar,
  onAbrirProduto,
  onCadastrarProduto,
  assistente,
}: EstoqueEProdutosProps) {
  const [busca, setBusca] = useState('');
  const [situacao, setSituacao] = useState<SituacaoDeEstoque>('all');
  const [categoriaId, setCategoriaId] = useState('all');
  const [precoMinimo, setPrecoMinimo] = useState('');
  const [precoMaximo, setPrecoMaximo] = useState('');

  const base = produtos ?? SEM_PRODUTOS;

  const listaVisivel = useMemo(
    () =>
      base.filter((p) => {
        const q = busca.toLowerCase();
        const combinaBusca = q
          ? p.nome.toLowerCase().includes(q) || (!!p.codigo && p.codigo.toLowerCase().includes(q))
          : true;

        const combinaSituacao = situacao === 'all'
          ? true
          : situacao === 'active'
            ? p.estoque > 0
            : p.estoque <= 0;

        const combinaCategoria = categoriaId === 'all' ? true : p.categoria_id === categoriaId;

        const preco = Number(p.preco);
        const minimo = precoMinimo ? Number(precoMinimo) : 0;
        const maximo = precoMaximo ? Number(precoMaximo) : Infinity;
        const combinaPreco = preco >= minimo && preco <= maximo;

        return combinaBusca && combinaSituacao && combinaCategoria && combinaPreco;
      }),
    [base, busca, situacao, categoriaId, precoMinimo, precoMaximo],
  );

  const semEstoque = base.filter((p) => p.estoque <= 0).length;
  const naoSincronizados = base.filter((p) => !isProdutoSynced(p.bling_id)).length;

  const nuncaCarregou = produtos === null;
  const mostrarErroDeCarga = nuncaCarregou && erroDeLeitura !== null && !carregando;
  const mostrarCarregando = nuncaCarregou && !mostrarErroDeCarga;
  const mostrarAvisoDeAtualizacao = !nuncaCarregou && erroDeLeitura !== null;

  return (
    <div className={`flex flex-col flex-1 min-h-0 ${responsive.page}`} style={{ gap: 'var(--conteudo-gap)' }}>

      <div className={`flex items-start gap-8 flex-none ${helpPageHeader}`}>
        <div className="flex flex-col flex-none" style={{ width: 'var(--titulo-col)', gap: 13 }}>
          <HelpContext ajudaId="estoque.lista">
            <h1
              className="m-0"
              style={{
                fontFamily: 'var(--font-space-grotesk), sans-serif',
                fontWeight: 500,
                fontSize: 'var(--titulo-fs)',
                lineHeight: 1.04,
                letterSpacing: '-0.03em',
                color: 'var(--txt)',
              }}
            >
              Estoque &amp;<br />Produtos
            </h1>
          </HelpContext>
          <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
            espelho do catálogo do Bling
          </span>
        </div>

        {/*
          Os três números só existem quando existe uma leitura para resumir.
          Sem ela, mostrariam "0" ao lado de uma leitura que FALHOU — o mesmo
          erro de confundir zero com "não sei", na posição mais visível da tela.
        */}
        {!nuncaCarregou && (
          <div
            className="flex-1 min-w-0 grid"
            style={{ gridTemplateColumns: 'repeat(3, 1fr)', gap: 'var(--resumo-gap)' }}
          >
            <Resumo rotulo="Produtos no catálogo" valor={base.length} cor="var(--txt)" />
            <Resumo rotulo="Sem estoque" valor={semEstoque} cor="var(--danger)" />
            <Resumo rotulo="Não sincronizados" valor={naoSincronizados} cor="var(--warning)" />
          </div>
        )}
      </div>

      {/* Toolbar: situação, busca, categoria, faixa de preço, cadastrar. */}
      <div className="flex items-center flex-none flex-wrap" style={{ gap: 10 }}>
        <div
          className={`flex ${responsive.pills}`}
          style={{ gap: 3, padding: 4, borderRadius: 14, background: 'var(--chip)', border: '1px solid var(--line)' }}
        >
          {SITUACOES.map((s) => {
            const ativo = situacao === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setSituacao(s.id)}
                aria-pressed={ativo}
                className="cursor-pointer"
                style={{
                  height: 30,
                  padding: '0 13px',
                  borderRadius: 11,
                  font: '600 12px/1 var(--font-archivo), sans-serif',
                  background: ativo ? 'var(--txt)' : 'transparent',
                  color: ativo ? 'var(--invTxt)' : 'var(--txt2)',
                }}
              >
                {s.rotulo}
              </button>
            );
          })}
        </div>

        <div
          className={`flex items-center flex-1 min-w-0 ${responsive.search}`}
          style={{
            gap: 10,
            height: 38,
            maxWidth: 300,
            padding: '0 14px',
            borderRadius: 13,
            background: 'var(--glass2)',
            border: '1px solid var(--line)',
          }}
        >
          <Search className="w-[18px] h-[18px] shrink-0" style={{ color: 'var(--txt3)' }} aria-hidden />
          <input
            type="search"
            value={busca}
            onChange={(evento) => setBusca(evento.target.value)}
            placeholder="Nome ou SKU"
            aria-label="Buscar produto por nome ou SKU"
            className="flex-1 min-w-0 bg-transparent outline-none"
            style={{ font: '400 13px/1 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
          />
        </div>

        <select
          value={categoriaId}
          onChange={(evento) => setCategoriaId(evento.target.value)}
          aria-label="Categoria"
          className="cursor-pointer outline-none"
          style={{
            height: 38,
            maxWidth: 190,
            padding: '0 13px',
            borderRadius: 13,
            background: 'var(--glass2)',
            border: '1px solid var(--line)',
            color: 'var(--txt2)',
            font: '600 12.5px/1 var(--font-archivo), sans-serif',
          }}
        >
          <option value="all">Todas as categorias</option>
          {categorias.map((categoria) => (
            <option key={categoria.id || categoria.bling_id} value={categoria.id || String(categoria.bling_id)}>
              {categoria.descricao}
            </option>
          ))}
        </select>

        <div
          className="flex items-center"
          style={{
            gap: 6,
            height: 38,
            padding: '0 12px',
            borderRadius: 13,
            background: 'var(--glass2)',
            border: '1px solid var(--line)',
          }}
        >
          <span style={{ font: '400 11px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>R$</span>
          <input
            type="number"
            value={precoMinimo}
            onChange={(evento) => setPrecoMinimo(evento.target.value)}
            placeholder="mín"
            aria-label="Preço mínimo"
            className="bg-transparent outline-none"
            style={{ width: 56, font: '400 12.5px/1 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
          />
          <span style={{ color: 'var(--txt3)' }}>–</span>
          <input
            type="number"
            value={precoMaximo}
            onChange={(evento) => setPrecoMaximo(evento.target.value)}
            placeholder="máx"
            aria-label="Preço máximo"
            className="bg-transparent outline-none"
            style={{ width: 56, font: '400 12.5px/1 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
          />
        </div>

        <button
          type="button"
          onClick={onCadastrarProduto}
          className="orbita-chip cursor-pointer"
          style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
        >
          <Package className="w-4 h-4" />
          Cadastrar produto
        </button>
        {assistente}
      </div>

      {mostrarAvisoDeAtualizacao && (
        <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura ?? undefined} recurso="o catálogo" />
      )}

      {mostrarCarregando && <EstadoCarregando mensagem="Carregando o catálogo…" />}

      {mostrarErroDeCarga && (
        <EstadoDeErro
          titulo="Não foi possível carregar o catálogo"
          detalhe={erroDeLeitura ?? undefined}
          onTentarDeNovo={onRecarregar}
        />
      )}

      {!nuncaCarregou && listaVisivel.length === 0 && (
        <EstadoVazio
          titulo={base.length === 0 ? 'Nenhum produto no catálogo' : 'Nenhum produto corresponde aos filtros'}
          descricao={
            base.length === 0
              ? 'Sincronize o Bling para importar o seu catálogo, ou cadastre um produto por aqui.'
              : 'Limpe a busca, a categoria ou a faixa de preço para ver os demais produtos.'
          }
        />
      )}

      {!nuncaCarregou && listaVisivel.length > 0 && (
        <TabelaDeProdutos
          produtos={listaVisivel}
          categorias={categorias}
          onAbrir={onAbrirProduto}
          rodape={
            `${listaVisivel.length} de ${base.length} produtos`
            + (naoSincronizados > 0 ? ` · ${naoSincronizados} ainda não existem no Bling` : '')
          }
        />
      )}
    </div>
  );
}
