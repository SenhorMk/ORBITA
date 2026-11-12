import { NextResponse } from 'next/server';

import { MENSAGEM_PUBLICA_DE_FALHA, registrarFalhaInterna } from '@/lib/observability/falhaInterna';
import { resolveActiveRequestOrganizationContext } from '@/lib/requestOrganizationContext';
import { supabaseServer } from '@/lib/supabaseServer';
import { confirmarCliente, criarConsultaDePedidos, lerVerificacao, revogarVerificacao } from '@/services/sac/clienteVerificado';
import { lerRetratoDoPedido } from '@/services/sac/retratoDoPedido';

import { criarRotasDaVerificacao } from './handlers';

/** As rotas de produção: as mesmas regras de `handlers.ts`, ligadas ao Supabase do servidor. */
const rotas = criarRotasDaVerificacao({
  resolverContexto: resolveActiveRequestOrganizationContext,
  ler: (scope, conversaId) => lerVerificacao(supabaseServer, scope, conversaId),
  confirmar: (scope, comando) => confirmarCliente(supabaseServer, scope, comando),
  revogar: (scope, conversaId) => revogarVerificacao(supabaseServer, scope, conversaId),
  consultaDePedidos: (scope, conversaId) => criarConsultaDePedidos(supabaseServer, scope, conversaId),
  retrato: (scope, conversaId, pedidoId) => lerRetratoDoPedido(supabaseServer, scope, conversaId, pedidoId),
});

/** Falha inesperada: registrada sem mensagem do banco e respondida sem detalhe. */
export function comFalhaSegura(operacao: string, rota: keyof typeof rotas) {
  return async function tratar(request: Request) {
    try {
      return await rotas[rota](request);
    } catch (erro: unknown) {
      registrarFalhaInterna(operacao, erro);
      return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
    }
  };
}
