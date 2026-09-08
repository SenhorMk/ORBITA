'use client';

import {
  AvisoDeAtualizacaoFalhada,
  EstadoCarregando,
  EstadoDeErro,
  EstadoVazio,
} from '@/components/ui/estados';

import { FluxoDeCaixa } from './FluxoDeCaixa';
import { TabelaDeMovimentacoes } from './Movimentacoes';
import { ResumoFinanceiro } from './ResumoFinanceiro';
import type { PontoDoFluxo, ResumoFinanceiro as Resumo, TituloFinanceiro } from './useLeituraFinanceira';

/**
 * As duas metades visuais do Financeiro: o cabeçalho com os totais e o corpo
 * com o fluxo de caixa e as movimentações.
 *
 * Elas moram aqui, e não no container, porque o container já carrega o estado
 * dos dois diálogos e do cadastro de fornecedor. Nada nestas duas funções
 * decide regra financeira — elas só escolhem qual das quatro situações de
 * leitura mostrar.
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
    <div className="flex items-start gap-8 flex-none">
      <div className="flex flex-col flex-none" style={{ width: 'var(--titulo-col)', gap: 13 }}>
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
          Controle<br />Financeiro
        </h1>
        <span style={{ font: '400 11px/1.4 var(--font-jetbrains-mono), monospace', color: 'var(--txt3)' }}>
          gestão simplificada de fluxo de caixa e saídas
        </span>
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
  chartData,
  formatarDinheiro,
  onRecarregar,
}: {
  estado: EstadoDaLeitura;
  titulos: readonly TituloFinanceiro[];
  chartData: readonly PontoDoFluxo[];
  formatarDinheiro: (valor: number) => string;
  onRecarregar: () => void;
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
    <>
      {erroDeLeitura !== null && (
        <AvisoDeAtualizacaoFalhada detalhe={erroDeLeitura} recurso="o financeiro" />
      )}

      <FluxoDeCaixa chartData={chartData} formatarDinheiro={formatarDinheiro} />

      {titulos.length === 0 ? (
        <EstadoVazio
          titulo="Nenhuma movimentação encontrada"
          descricao="Sincronize o Bling para trazer os títulos financeiros, ou registre uma saída por aqui."
        />
      ) : (
        <TabelaDeMovimentacoes titulos={titulos} formatarDinheiro={formatarDinheiro} />
      )}
    </>
  );
}
