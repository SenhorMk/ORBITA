import { NextResponse } from 'next/server';

import { autorizarCorrecaoOperacional, auditarCorrecao } from '@/lib/correcaoOperacionalServidor';
import { getCorrelationId } from '@/lib/observability/correlation';
import { registrarFalhaInterna, MENSAGEM_PUBLICA_DE_FALHA } from '@/lib/observability/falhaInterna';
import { clienteRepository } from '@/repositories/clienteRepository';
import { bling } from '@/services/bling';

import { createExclusaoDeClienteHandler } from './handler';

const excluirCliente = createExclusaoDeClienteHandler({
  autorizar: autorizarCorrecaoOperacional,
  store: clienteRepository,
  bling: (scope) => bling.forVerifiedOrganization(scope),
  auditar: auditarCorrecao,
  correlationId: getCorrelationId,
});

export async function POST(request: Request) {
  try {
    return await excluirCliente(request);
  } catch (err: unknown) {
    // Falha antes de qualquer efeito remoto (a carga do cliente, por exemplo).
    // A causa fica no log; a resposta é a frase fixa (CWE-209).
    registrarFalhaInterna('clientes.excluir', err);
    return NextResponse.json({ success: false, error: MENSAGEM_PUBLICA_DE_FALHA }, { status: 500 });
  }
}
