'use client';

import { useState } from 'react';
import { z } from 'zod';

import type { AuthenticatedFetch } from '@/components/organizacao/useOrganizationPanel';
import { Aviso } from './Aviso';
import { HelpContext } from '@/components/help/HelpContext';

const RespostaSchema = z.object({
  estado: z.literal('rascunho'), texto: z.string(), provedor: z.enum(['fake', 'google']),
});

const MENSAGENS: Record<string, string> = {
  aguardando_contexto: 'Aguarde a triagem do contexto atual e tente novamente.',
  contexto_mudou: 'A conversa mudou durante a geração. Peça um novo rascunho.',
  entrada_bloqueada: 'O contexto não pôde ser usado. Continue o atendimento manualmente.',
  desligada: 'Geração de rascunhos indisponível neste ambiente.',
  resposta_invalida: 'A IA devolveu uma resposta inválida. Continue o atendimento manualmente.',
  modelo_indisponivel: 'A IA está indisponível. Continue o atendimento manualmente.',
};

type Estado =
  | { tipo: 'inicial' | 'gerando' }
  | { tipo: 'erro'; texto: string }
  | { tipo: 'rascunho'; texto: string; provedor: 'fake' | 'google' };

export function PainelDaResposta({ fetchWithAuth, conversaId, compositorOcupado, usar }: {
  readonly fetchWithAuth: AuthenticatedFetch;
  readonly conversaId: string;
  readonly compositorOcupado: boolean;
  readonly usar: (texto: string) => void;
}) {
  const [estado, setEstado] = useState<Estado>({ tipo: 'inicial' });

  async function gerar() {
    setEstado({ tipo: 'gerando' });
    try {
      const resposta = await fetchWithAuth(`/api/sac/resposta?conversaId=${conversaId}`, { method: 'POST' });
      const corpo: unknown = await resposta.json();
      const rascunho = RespostaSchema.safeParse(corpo);
      if (resposta.ok && rascunho.success) {
        setEstado({ tipo: 'rascunho', texto: rascunho.data.texto, provedor: rascunho.data.provedor });
        return;
      }
      const erro = z.object({ estado: z.string() }).safeParse(corpo);
      setEstado({ tipo: 'erro', texto: erro.success
        ? (MENSAGENS[erro.data.estado] ?? 'Não foi possível gerar o rascunho.')
        : 'Não foi possível gerar o rascunho.' });
    } catch {
      setEstado({ tipo: 'erro', texto: 'Não foi possível gerar o rascunho.' });
    }
  }

  return (
    <section aria-label="Resposta sugerida" className="flex flex-col gap-2 p-3">
      <HelpContext ajudaId="sac.rascunho">
      <button type="button" className="orbita-chip self-start cursor-pointer" disabled={estado.tipo === 'gerando'}
        onClick={() => void gerar()}>
        {estado.tipo === 'gerando' ? 'Gerando rascunho…' : 'Gerar rascunho de resposta'}
      </button>
      </HelpContext>
      {estado.tipo === 'erro' && <Aviso tom="atencao">{estado.texto}</Aviso>}
      {estado.tipo === 'rascunho' && (
        <>
          <output className="whitespace-pre-wrap">{estado.texto}</output>
          <small>{estado.provedor === 'fake' ? 'Modelo de demonstração. ' : ''}Revise antes de enviar.</small>
          <button type="button" className="orbita-chip self-start cursor-pointer" disabled={compositorOcupado}
            onClick={() => { usar(estado.texto); setEstado({ tipo: 'inicial' }); }}>
            Usar no compositor
          </button>
        </>
      )}
    </section>
  );
}
