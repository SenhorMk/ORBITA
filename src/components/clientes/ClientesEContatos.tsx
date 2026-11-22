'use client';

import { HelpContext, helpPageHeader } from '@/components/help/HelpContext';

import { Plus } from 'lucide-react';

import type { Cliente } from '@/types';
import {
  AvisoDeAtualizacaoFalhada,
  EstadoCarregando,
  EstadoDeErro,
  EstadoVazio,
} from '@/components/ui/estados';
import { TabelaDeClientes } from './TabelaDeClientes';

/**
 * Clientes & Contatos, na linguagem do produto novo.
 *
 * A tela lista todos os clientes, sem busca nem recorte. O que ela oferece:
 * listar, abrir o detalhe, cadastrar e editar.
 *
 * Carregando, vazio e erro são três coisas diferentes, pela mesma razão de
 * sempre — uma leitura que falhou não pode virar "nenhum cliente".
 */

interface ClientesEContatosProps {
  /** Os clientes da última leitura boa, ou `null` se nenhuma leitura deu certo ainda. */
  clientes: readonly Cliente[] | null;
  carregando: boolean;
  /** A falha da leitura mais recente, se houve. */
  erroDeLeitura: string | null;
  onRecarregar: () => void;
  onAbrirCliente: (cliente: Cliente) => void;
  onCadastrarCliente: () => void;
}

export function ClientesEContatos({
  clientes,
  carregando,
  erroDeLeitura,
  onRecarregar,
  onAbrirCliente,
  onCadastrarCliente,
}: ClientesEContatosProps) {
  const lista = clientes ?? [];
  const noBling = lista.filter((c) => String(c.bling_id ?? '').trim() !== '').length;

  const nuncaCarregou = clientes === null;
  const mostrarErroDeCarga = nuncaCarregou && erroDeLeitura !== null && !carregando;
  const mostrarCarregando = nuncaCarregou && !mostrarErroDeCarga;
  const mostrarAvisoDeAtualizacao = !nuncaCarregou && erroDeLeitura !== null;

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ gap: 'var(--conteudo-gap)' }}>

      <div className={`flex items-start gap-8 flex-none ${helpPageHeader}`}>
        <div className="flex flex-col flex-none" style={{ width: 'var(--titulo-col)', gap: 13 }}>
          <HelpContext ajudaId="clientes.lista">
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
              Clientes &amp;<br />Contatos
            </h1>
          </HelpContext>
          <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
            {nuncaCarregou
              ? 'base de contatos da organização'
              : `${lista.length} contatos · ${noBling} com contraparte no Bling`}
          </span>
        </div>

        <div className="flex-1 flex items-start justify-end">
          <button
            type="button"
            onClick={onCadastrarCliente}
            className="orbita-chip cursor-pointer"
            style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            <Plus className="w-4 h-4" />
            Novo contato
          </button>
        </div>
      </div>

      {mostrarAvisoDeAtualizacao && (
        <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura ?? undefined} recurso="os contatos" />
      )}

      {mostrarCarregando && <EstadoCarregando mensagem="Carregando os contatos…" />}

      {mostrarErroDeCarga && (
        <EstadoDeErro
          titulo="Não foi possível carregar os contatos"
          detalhe={erroDeLeitura ?? undefined}
          onTentarDeNovo={onRecarregar}
        />
      )}

      {!nuncaCarregou && lista.length === 0 && (
        <EstadoVazio
          titulo="Nenhum contato cadastrado"
          descricao="Sincronize o Bling para importar os contatos, ou cadastre um por aqui."
        />
      )}

      {!nuncaCarregou && lista.length > 0 && (
        <TabelaDeClientes
          clientes={lista}
          onAbrir={onAbrirCliente}
          rodape={`${lista.length} contatos`}
        />
      )}
    </div>
  );
}
