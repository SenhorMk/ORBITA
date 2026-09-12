'use client';

import Image from 'next/image';
import { ImageIcon } from 'lucide-react';

import type { Categoria, Produto } from '@/types';
import { Pilula } from '@/components/ui/StatusPill';
import { MolduraDeTabela } from '@/components/ui/MolduraDeTabela';
import { isProdutoSynced, pendenciasLocaisDoProduto } from '@/lib/utils';

/**
 * A tabela do catálogo.
 *
 * É a tabela desta tela, escrita para ela — e não um componente genérico de
 * tabelas, pela mesma razão que Vendas não criou um: as colunas são fixas e
 * conhecidas, e um `DataTable` configurável seria mais código a serviço de dois
 * chamadores. O que Estoque e Clientes repetiam de verdade era só o contorno, e
 * é ele que está em `MolduraDeTabela`.
 *
 * O que **não** mudou de significado ao trocar de casca:
 *
 * - **sincronizado** continua sendo `isProdutoSynced(bling_id)`, a mesma
 *   verificação de antes, e nenhum status novo de Bling foi inventado;
 * - o produto que ainda não subiu para o ERP continua mostrando, na própria
 *   linha, o que falta para ele passar em `validateProdutoForBling` — antes isso
 *   vivia numa segunda lista embaixo; agora é uma coluna e uma linha de aviso, e
 *   a informação é a mesma;
 * - os três faixas de saldo são as de antes: `<= 0` sem estoque, `< 5` estoque
 *   baixo, o resto em estoque.
 */

const GRADE = 'var(--tabela-produtos-cols)';

/** A soma das colunas na geometria de 1366 — abaixo disso a tabela rola dentro da moldura. */
const LARGURA_MINIMA = 980;

function formatarReais(valor: number | string | null | undefined): string {
  const numero = Number(valor ?? 0);
  return (Number.isFinite(numero) ? numero : 0).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function saldoDoProduto(estoque: number): { rotulo: string; cor: string } {
  if (estoque <= 0) return { rotulo: 'Sem estoque', cor: 'var(--danger)' };
  if (estoque < 5) return { rotulo: 'Estoque baixo', cor: 'var(--warning)' };
  return { rotulo: 'Em estoque', cor: 'var(--accent)' };
}

function Miniatura({ produto }: { produto: Produto }) {
  return (
    <span
      className="relative flex items-center justify-center shrink-0 overflow-hidden"
      style={{ width: 34, height: 34, borderRadius: 10, background: 'var(--chip)', border: '1px solid var(--line)' }}
      aria-hidden
    >
      <ImageIcon className="absolute w-4 h-4" style={{ color: 'var(--txt3)' }} />
      {produto.imagem_url && (
        <Image
          src={produto.imagem_url}
          alt=""
          width={34}
          height={34}
          unoptimized
          className="relative h-full w-full object-cover"
          onError={(evento) => {
            evento.currentTarget.style.display = 'none';
          }}
        />
      )}
    </span>
  );
}

export function TabelaDeProdutos({
  produtos,
  categorias,
  onAbrir,
  rodape,
}: {
  produtos: readonly Produto[];
  categorias: readonly Categoria[];
  onAbrir: (produto: Produto) => void;
  rodape: string;
}) {
  return (
    <MolduraDeTabela larguraMinima={LARGURA_MINIMA} rodape={rodape}>
      <div
        className="orbita-tabela-cabecalho grid items-center"
        style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
      >
        <span>PRODUTO</span>
        <span>SKU</span>
        <span>CATEGORIA</span>
        <span>ESPELHO BLING</span>
        <span>ESTOQUE</span>
        <span className="text-right">PREÇO</span>
        <span />
      </div>

      {produtos.map((produto) => {
        const sincronizado = isProdutoSynced(produto.bling_id);
        // Só o que o registro LOCAL guarda e a pessoa consegue corrigir nesta
        // linha. O validador do payload do Bling exige `tipo`, `situacao` e
        // `formato`, que esta tabela não tem por construção — pedi-los aqui
        // relatava ausência de campo que o banco nem persiste.
        const pendencias = sincronizado ? [] : pendenciasLocaisDoProduto(produto);
        const saldo = saldoDoProduto(produto.estoque);
        const categoria = categorias.find((c) => c.id === produto.categoria_id);
        const sku = produto.codigo?.trim()
          || (sincronizado ? `BLING-${produto.bling_id}` : String(produto.bling_id));

        return (
          <div
            key={produto.id || produto.bling_id}
            className="orbita-tabela-linha grid items-center"
            style={{
              gridTemplateColumns: GRADE,
              gap: 'var(--tabela-gap)',
              padding: '0 var(--tabela-pad)',
              // Uma linha com pendências precisa de espaço para dizê-las; as
              // demais mantêm a altura do preset de geometria.
              height: pendencias.length > 0 ? 'auto' : undefined,
              minHeight: 'var(--linha-h)',
            }}
          >
            <button
              type="button"
              onClick={() => onAbrir(produto)}
              className="flex items-center min-w-0 text-left cursor-pointer"
              style={{ gap: 10, padding: '9px 0' }}
            >
              <Miniatura produto={produto} />
              <span className="flex flex-col min-w-0" style={{ gap: 3 }}>
                <span
                  className="truncate"
                  style={{ font: '500 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
                >
                  {produto.nome || 'Produto sem nome'}
                </span>
                {pendencias.length > 0 && (
                  <span
                    style={{ font: '400 10.5px/1.35 var(--font-archivo), sans-serif', color: 'var(--danger)' }}
                  >
                    Faltam dados: {pendencias.join(' · ')}
                  </span>
                )}
              </span>
            </button>

            <span
              className="truncate"
              style={{ font: '400 11.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt2)' }}
              title={sku}
            >
              {sku}
            </span>

            <span
              className="truncate"
              style={{ font: '400 12px/1.3 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
            >
              {categoria?.descricao ?? '—'}
            </span>

            <Pilula
              rotulo={sincronizado ? 'Bling' : 'Não sincronizado'}
              cor={sincronizado ? 'var(--accent)' : 'var(--warning)'}
            />

            <span className="flex items-center" style={{ gap: 8 }}>
              <span style={{ font: '500 12px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt)' }}>
                {produto.estoque} un
              </span>
              <Pilula rotulo={saldo.rotulo} cor={saldo.cor} />
            </span>

            <span
              className="text-right orbita-numero"
              style={{ fontSize: 14 }}
            >
              {formatarReais(produto.preco)}
            </span>

            <span className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => onAbrir(produto)}
                className="orbita-chip cursor-pointer"
                style={{ height: 30, fontSize: 11.5 }}
              >
                {sincronizado ? 'Detalhes' : 'Corrigir'}
              </button>
            </span>
          </div>
        );
      })}
    </MolduraDeTabela>
  );
}
