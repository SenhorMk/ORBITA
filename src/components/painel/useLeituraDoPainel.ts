'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { Categoria, Cliente, Produto } from '@/types';
import type { PedidoEnriquecido } from '@/repositories/pedidoRepository';
import { fetchWithAuth } from '@/lib/fetchWithAuth';
import { descreverErro } from '@/lib/erroLegivel';

/** O que `GET /api/dashboard` devolve. O contrato não mudou. */
export interface DadosDoPainel {
  pedidos: PedidoEnriquecido[];
  produtos: Produto[];
  /** Arquivados (aqui ou excluídos no Bling), para a aba separada de Estoque. */
  produtosArquivados?: Produto[];
  clientes: Cliente[];
  categorias?: Categoria[];
  estatisticas: {
    faturamento30Dias: number;
    faturamento30DiasAnterior: number;
    totalPedidos: number;
    pendentes: number;
    cancelados: number;
    atendidos: number;
  };
}

interface DoEscopo<T> {
  readonly escopo: string;
  readonly valor: T;
}

const INTERVALO_DE_ATUALIZACAO_MS = 30_000;

/**
 * A leitura operacional do painel, **carimbada pelo escopo que a produziu**.
 *
 * ## Por que o carimbo
 *
 * Pedidos, produtos e clientes pertencem a uma organização. Guardá-los sem
 * dizer de qual abre dois caminhos, e os dois aconteceram de verdade em
 * produtos multi-tenant:
 *
 * 1. **A janela da troca.** Enquanto a leitura da organização B não volta, os
 *    números de A continuam na tela — agora sob o nome de B, porque o shell já
 *    anunciou a troca. Se a leitura de B falhar, ficam lá.
 * 2. **A resposta fora de ordem.** A requisição de A sai, o usuário troca para
 *    B, B responde, e só então A responde. Sem carimbo, A sobrescreve B.
 *
 * A solução é a mesma de `useOrganizationsList` e de
 * `usePapelNaOrganizacaoAtiva`, pela mesma razão: o dado carrega de quem ele é.
 * Nada é exposto sem o carimbo bater com o escopo corrente, e nada é gravado
 * por uma resposta de escopo que já não é o atual.
 *
 * `setData(null)` na troca fecharia só o primeiro caminho. O segundo exige o
 * carimbo.
 *
 * ## O que continua igual
 *
 * Falhar a **atualização** dentro do mesmo escopo preserva a última leitura boa
 * daquele escopo e mostra o erro ao lado — zero e "não sei" continuam sendo
 * coisas diferentes. O que não sobrevive é o dado de **outro** escopo.
 *
 * @param escopo - Identifica a quem pertence o que for lido: identidade da
 *   sessão e organização ativa **com a versão da seleção**, porque sair de uma
 *   organização e voltar são seleções diferentes. `null` quando não há sessão —
 *   aí não se pergunta nada.
 */
export function useLeituraDoPainel(escopo: string | null) {
  const [leitura, setLeitura] = useState<DoEscopo<DadosDoPainel> | null>(null);
  const [erro, setErro] = useState<DoEscopo<string> | null>(null);
  const [buscando, setBuscando] = useState(false);
  const escopoAtualRef = useRef(escopo);

  const lerNoEscopo = useCallback(async (doEscopo: string) => {
    setBuscando(true);
    try {
      const response = await fetchWithAuth('/api/dashboard');
      const result = await response.json();
      // Daqui para baixo é tudo escrita: se o carimbo não confere, esta
      // resposta é de outra organização (ou de outra sessão) e não tem onde
      // ser aplicada.
      if (escopoAtualRef.current !== doEscopo) return;
      if (!response.ok || !result.success) {
        setErro({ escopo: doEscopo, valor: descreverErro(result?.error ?? `HTTP ${response.status}`) });
        return;
      }
      setErro(null);
      setLeitura({ escopo: doEscopo, valor: result.data as DadosDoPainel });
    } catch (problema: unknown) {
      if (escopoAtualRef.current !== doEscopo) return;
      setErro({ escopo: doEscopo, valor: descreverErro(problema) });
    } finally {
      if (escopoAtualRef.current === doEscopo) setBuscando(false);
    }
  }, []);

  const recarregar = useCallback(async () => {
    if (escopo === null) return;
    await lerNoEscopo(escopo);
  }, [escopo, lerNoEscopo]);

  useEffect(() => {
    escopoAtualRef.current = escopo;
    if (escopo === null) return;
    // A leitura é disparada e esquecida: tudo que ela grava acontece depois da
    // resposta do servidor, nunca durante o efeito.
    void (async () => {
      await lerNoEscopo(escopo);
    })();
    const intervalo = setInterval(() => {
      void lerNoEscopo(escopo);
    }, INTERVALO_DE_ATUALIZACAO_MS);
    return () => clearInterval(intervalo);
  }, [escopo, lerNoEscopo]);

  const valeAgora = escopo !== null && leitura !== null && leitura.escopo === escopo;
  const dados = valeAgora ? leitura.valor : null;
  const mensagemDeErro = escopo !== null && erro !== null && erro.escopo === escopo ? erro.valor : null;

  /**
   * Altera a leitura corrente sem ir ao servidor (a troca de imagem de produto
   * faz isso). Só mexe no que pertence ao escopo atual.
   */
  const atualizarDados = useCallback(
    (alterar: (anterior: DadosDoPainel) => DadosDoPainel) => {
      setLeitura((anterior) =>
        anterior !== null && anterior.escopo === escopoAtualRef.current
          ? { escopo: anterior.escopo, valor: alterar(anterior.valor) }
          : anterior,
      );
    },
    [],
  );

  return {
    dados,
    erro: mensagemDeErro,
    // Há escopo, ainda não há leitura dele, e nada falhou: é isso que carregar
    // significa. Trocar de organização volta sozinho para "carregando", sem
    // ninguém precisar zerar nada.
    carregando: escopo !== null && !valeAgora && mensagemDeErro === null,
    buscando,
    recarregar,
    atualizarDados,
  };
}
