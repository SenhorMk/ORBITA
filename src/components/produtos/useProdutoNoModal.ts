'use client';

import { useCallback, useState } from 'react';

import type { Produto } from '@/types';

/** A seleção do modal e o escopo em que ela foi feita. `produto: null` é o cadastro novo. */
interface SelecaoCarimbada {
  readonly escopo: string;
  readonly produto: Produto | null;
}

/**
 * O produto aberto no `ProductDetailModal`, **carimbado pelo escopo da leitura
 * que o produziu** — o mesmo `escopoDaLeitura` de `useLeituraDoPainel`.
 *
 * O produto aberto é uma cópia do registro de uma organização, e com a foto do
 * produto ele carrega uma URL assinada do bucket privado daquela organização.
 * Guardá-lo em estado solto deixava o modal de A aberto depois de o shell já
 * mostrar B.
 *
 * A elegibilidade é derivada no próprio render, e não fechada por efeito: no
 * render em que o escopo passa a ser B, a seleção feita em A já não é
 * exposta. Um `useEffect` que fechasse o modal deixaria um render (com paint)
 * do tenant anterior. Voltar para A também não a reabre — sair e voltar são
 * seleções com versões diferentes, e o escopo carrega a versão.
 *
 * Nada além de um clique grava a seleção, então uma resposta tardia do painel
 * de A não tem como abrir nem popular o modal.
 */
export function useProdutoNoModal(escopo: string | null) {
  const [selecao, setSelecao] = useState<SelecaoCarimbada | null>(null);

  const abrir = useCallback((produto: Produto) => {
    if (escopo !== null) setSelecao({ escopo, produto });
  }, [escopo]);

  const abrirCadastro = useCallback(() => {
    if (escopo !== null) setSelecao({ escopo, produto: null });
  }, [escopo]);

  const fechar = useCallback(() => setSelecao(null), []);

  const vigente = escopo !== null && selecao !== null && selecao.escopo === escopo ? selecao : null;

  return {
    aberto: vigente !== null,
    produto: vigente?.produto ?? null,
    abrir,
    abrirCadastro,
    fechar,
  };
}
