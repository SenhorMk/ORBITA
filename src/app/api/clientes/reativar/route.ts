import { NextResponse } from 'next/server';

import { autorizarCorrecaoOperacional, auditarCorrecao } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';

import { createReativacaoDeContatoHandler } from './handler';

const reativarContato = createReativacaoDeContatoHandler({
  autorizar: autorizarCorrecaoOperacional,
  store: clienteRepository,
  bling: (scope) => bling.forVerifiedOrganization(scope),
  auditar: auditarCorrecao,
  correlationId: getCorrelationId,
});

export async function POST(request: Request) {
  try {
    return await reativarContato(request);
  } catch (err: unknown) {
    // Falha antes da reativação (leitura do banco ou do Bling). A causa fica no
    // log; a resposta é a frase fixa (CWE-209).
    registrarFalhaInterna('clientes.reativar', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
