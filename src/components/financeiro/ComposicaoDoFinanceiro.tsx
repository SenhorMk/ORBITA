'use client';

import { HelpContext, helpPageHeader } from '@/components/help/HelpContext';

import {
  AvisoDeAtualizacaoFalhada,
  EstadoCarregando,
  EstadoDeErro,
  EstadoVazio,
} from '@/components/ui/estados';

import type { BarraDoDia, PontoDoFluxo } from './derivacoesDoFinanceiro';
import { EntradasESaidas, FluxoDeCaixa } from './Graficos';
import { TabelaDeMovimentacoes } from './Movimentacoes';
import { ResumoFinanceiro } from './ResumoFinanceiro';
import type { ResumoFinanceiro as Resumo, TituloFinanceiro } from './useLeituraFinanceira';

/**
 * As duas metades visuais do Financeiro: o cabeçalho com os totais e o corpo,
 * agora em duas colunas — os dois gráficos à esquerda, o extrato à direita.
 *
 * A moldura vertical do corpo existe por um defeito concreto: a tabela era o
 * único elemento flexível da coluna e ficava com o que sobrasse depois do
 * cabeçalho, da toolbar e de gráficos de altura fixa. Numa janela baixa
 * (1366×768 vira ~657px de viewport depois da moldura do navegador) sobravam
 * 50px — uma linha. A página inteira não rola, e não pode passar a rolar: o
 * Financeiro é uma tela full height. Por isso os gráficos dividem a coluna
 * esquerda com piso próprio (`--grafico-min`) e a tabela ocupa a coluna direita
 * inteira, rolando por dentro da `MolduraDeTabela`.
 */

interface EstadoDaLeitura {
  nuncaCarregou: boolean;
  erroDeLeitura: string | null;
  carregando: boolean;
}

export function CabecalhoDoFinanceiro({
  resumo,
  formatarDinheiro,
}: {
  resumo: Resumo | null;
  formatarDinheiro: (valor: number) => string;
}) {
  return (
    <div className={`flex items-center gap-8 flex-none ${helpPageHeader}`}>
      <div className="flex flex-col gap-2 shrink-0">
        <HelpContext ajudaId="financeiro.visao">
          <h1
            className="m-0 flex-none"
            style={{
              width: 'var(--titulo-col)',
              fontFamily: 'var(--font-space-grotesk), sans-serif',
              fontWeight: 500,
              fontSize: 'var(--titulo-fs)',
              lineHeight: 1.04,
              letterSpacing: '-0.03em',
              color: 'var(--txt)',
            }}
          >
            Controle<br />Financeiro
          </h1>
        </HelpContext>
        <HelpContext ajudaId="financeiro.resumo"><span className="orbita-eyebrow">Resumo financeiro</span></HelpContext>
      </div>

      {/*
        Os três totais só existem quando existe uma leitura para resumir. Sem
        ela, mostrariam "R$ 0,00" ao lado de uma leitura que FALHOU — zero e
        "não sei" são coisas diferentes, e aqui a diferença é dinheiro.
      */}
      {resumo !== null && <ResumoFinanceiro resumo={resumo} formatarDinheiro={formatarDinheiro} />}
    </div>
  );
}

export function CorpoDoFinanceiro({
  estado,
  titulos,
  serie,
  barras,
  formatarDinheiro,
  onRecarregar,
  onAbrirDetalhe,
}: {
  estado: EstadoDaLeitura;
  titulos: readonly TituloFinanceiro[];
  serie: readonly PontoDoFluxo[];
  barras: readonly BarraDoDia[];
  formatarDinheiro: (valor: number) => string;
  onRecarregar: () => void;
  onAbrirDetalhe: (titulo: TituloFinanceiro) => void;
}) {
  const { nuncaCarregou, erroDeLeitura, carregando } = estado;

  if (carregando) return <EstadoCarregando mensagem="Carregando o financeiro…" />;

  if (nuncaCarregou) {
    return (
      <EstadoDeErro
        titulo="Não foi possível carregar o financeiro"
        detalhe={erroDeLeitura ?? undefined}
        onTentarDeNovo={onRecarregar}
      />
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0" style={{ gap: 'var(--conteudo-gap)' }}>
      {erroDeLeitura !== null && (
        <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura} recurso="o financeiro" />
      )}

      <div
        className="grid flex-1 min-h-0"
        style={{ gridTemplateColumns: 'var(--financeiro-cols)', gap: 'var(--conteudo-gap)' }}
      >
        <div className="flex flex-col min-h-0 min-w-0" style={{ gap: 'var(--conteudo-gap)' }}>
          <EntradasESaidas barras={barras} formatarDinheiro={formatarDinheiro} />
          <FluxoDeCaixa serie={serie} formatarDinheiro={formatarDinheiro} />
        </div>

        <div className="flex flex-col min-h-0 min-w-0">
          {titulos.length === 0 ? (
            <EstadoVazio
              titulo="Nenhuma movimentação no período"
              descricao="Amplie o período, troque o filtro, ou sincronize o Bling para trazer os títulos financeiros."
            />
          ) : (
            <TabelaDeMovimentacoes
              titulos={titulos}
              formatarDinheiro={formatarDinheiro}
              onAbrirDetalhe={onAbrirDetalhe}
            />
          )}
        </div>
      </div>
    </div>
  );
}
