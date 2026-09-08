'use client';

import type { Cliente } from '@/types';
import { Pilula } from '@/components/ui/StatusPill';
import { MolduraDeTabela } from '@/components/ui/MolduraDeTabela';

/**
 * A tabela de clientes.
 *
 * Três colunas da tabela antiga **não** estão aqui, e a ausência é deliberada:
 * "Localização" era a palavra `Brasil` escrita à mão para todo mundo, "Status"
 * era `Ativo` escrito à mão para todo mundo, e "Saldo" era `R$ 0,00` escrito à
 * mão para todo mundo. Nenhum dos três existe no contrato de cliente. Uma
 * coluna que mostra o mesmo literal em toda linha não informa nada e promete um
 * dado que o produto não tem — é a mesma razão pela qual Vendas não inventou as
 * colunas de canal e espelho que o protótipo pedia.
 *
 * A caixa de seleção da tabela antiga também saiu: não havia nenhuma ação em
 * lote para aplicar à seleção.
 *
 * O que ficou é o que o contrato de fato carrega: nome, documento, e-mail,
 * telefone e se o contato já tem contraparte no Bling.
 */

const GRADE = 'var(--tabela-clientes-cols)';

/** A soma das colunas na geometria de 1366 — abaixo disso a tabela rola dentro da moldura. */
const LARGURA_MINIMA = 880;

function iniciaisDe(nome: string): string {
  return nome
    .split(' ')
    .filter(Boolean)
    .map((parte) => parte[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function TabelaDeClientes({
  clientes,
  onAbrir,
  rodape,
}: {
  clientes: readonly Cliente[];
  onAbrir: (cliente: Cliente) => void;
  rodape: string;
}) {
  return (
    <MolduraDeTabela larguraMinima={LARGURA_MINIMA} rodape={rodape}>
      <div
        className="orbita-tabela-cabecalho grid items-center"
        style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
      >
        <span>CLIENTE</span>
        <span>CPF / CNPJ</span>
        <span>E-MAIL</span>
        <span>TELEFONE</span>
        <span>ESPELHO BLING</span>
        <span />
      </div>

      {clientes.map((cliente, indice) => {
        const nome = cliente.nome || 'Cliente sem nome';
        const noBling = String(cliente.bling_id ?? '').trim() !== '';

        return (
          <div
            key={cliente.id || cliente.bling_id || indice}
            className="orbita-tabela-linha grid items-center"
            style={{ gridTemplateColumns: GRADE, gap: 'var(--tabela-gap)', padding: '0 var(--tabela-pad)' }}
          >
            <button
              type="button"
              onClick={() => onAbrir(cliente)}
              className="flex items-center min-w-0 text-left cursor-pointer"
              style={{ gap: 10 }}
            >
              <span
                className="flex items-center justify-center shrink-0 rounded-full"
                style={{
                  width: 30,
                  height: 30,
                  background: 'var(--chip)',
                  border: '1px solid var(--line)',
                  font: '600 10.5px/1 var(--font-jetbrains-mono), monospace',
                  color: 'var(--txt2)',
                }}
                aria-hidden
              >
                {iniciaisDe(nome)}
              </span>
              <span
                className="truncate"
                style={{ font: '500 13px/1.2 var(--font-archivo), sans-serif', color: 'var(--txt)' }}
              >
                {nome}
              </span>
            </button>

            <span
              className="truncate"
              style={{ font: '400 11.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt2)' }}
            >
              {cliente.cpf_cnpj || '—'}
            </span>

            <span
              className="truncate"
              style={{ font: '400 12.5px/1.3 var(--font-archivo), sans-serif', color: 'var(--txt2)' }}
              title={cliente.email}
            >
              {cliente.email || '—'}
            </span>

            <span
              className="truncate"
              style={{ font: '400 11.5px/1 var(--font-jetbrains-mono), monospace', color: 'var(--txt2)' }}
            >
              {cliente.telefone || '—'}
            </span>

            <Pilula
              rotulo={noBling ? 'Bling' : 'Só no Orbita'}
              cor={noBling ? 'var(--accent)' : 'var(--txt3)'}
            />

            <span className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => onAbrir(cliente)}
                className="orbita-chip cursor-pointer"
                style={{ height: 30, fontSize: 11.5 }}
              >
                Detalhes
              </button>
            </span>
          </div>
        );
      })}
    </MolduraDeTabela>
  );
}
