import { describe, expect, it } from 'vitest';
import type { PapelMembro } from '@/lib/organizationContext';
import type { IdentidadeDeExibicao } from '@/lib/organizacao/identidadeDoMembro';
import type { AuditEventRecord } from '@/services/auditService';
import { atividadeSchema, montarHistorico, type PortasDoHistorico } from './historicoDeAtividades';

const MARIA = '11111111-1111-4111-8111-111111111111';
const JOAO = '22222222-2222-4222-8222-222222222222';

function evento(overrides: Partial<AuditEventRecord>): AuditEventRecord {
  return {
    id: 'e1', organizacaoId: 'org-a', actorId: null, acao: 'catalog.product_saved', recurso: 'produto',
    recursoId: '42', correlationId: 'corr-1', ipAddress: '10.0.0.1', userAgent: 'Navegador',
    metadata: {}, createdAt: '2026-11-24T12:00:00Z', ...overrides,
  };
}

function portas(papeis: Record<string, PapelMembro>, nomes: Record<string, string>) {
  const lidos: string[][] = [];
  const identidades: string[] = [];
  const p: PortasDoHistorico = {
    async lerPapeis(ids) {
      lidos.push([...ids]);
      return new Map(ids.filter((id) => papeis[id]).map((id) => [id, papeis[id]]));
    },
    async lerIdentidade(id): Promise<IdentidadeDeExibicao> {
      identidades.push(id);
      return nomes[id] ? { nome_exibicao: nomes[id], origem_do_nome: 'cadastro' } : { nome_exibicao: null, origem_do_nome: 'ausente' };
    },
  };
  return { p, lidos, identidades };
}

describe('montarHistorico', () => {
  it('identifica a pessoa que fez a ação pelo nome e pelo papel dela na organização', async () => {
    const { p } = portas({ [MARIA]: 'admin' }, { [MARIA]: 'Maria Silva' });
    const [atividade] = await montarHistorico([evento({ actorId: MARIA })], p);

    expect(atividade.autor).toEqual({ tipo: 'pessoa', userId: MARIA, papel: 'admin', nome_exibicao: 'Maria Silva', origem_do_nome: 'cadastro' });
    expect(atividade.descricao).toBe('Produto cadastrado ou atualizado no Bling e espelhado no ORBITA.');
    expect(atividade.viaAssistente).toBe(false);
  });

  it('quem saiu da organização continua identificado, com papel nulo', async () => {
    const { p } = portas({}, { [JOAO]: 'João' });
    const [atividade] = await montarHistorico([evento({ actorId: JOAO })], p);

    expect(atividade.autor).toMatchObject({ tipo: 'pessoa', userId: JOAO, papel: null, nome_exibicao: 'João' });
  });

  it('resposta automática da IA aparece como bot, e o resto sem pessoa como sistema', async () => {
    const { p } = portas({}, {});
    const [bot, sistema] = await montarHistorico([
      evento({ id: 'b', acao: 'chatwoot.send_requested', metadata: { origem: 'ia', run_id: 'r' } }),
      evento({ id: 's', acao: 'sac.case_opened' }),
    ], p);

    expect(bot.autor).toEqual({ tipo: 'bot' });
    expect(sistema.autor).toEqual({ tipo: 'sistema' });
  });

  it('edição pelo assistente fica com a pessoa que confirmou, marcada como via assistente', async () => {
    const { p } = portas({ [MARIA]: 'owner' }, { [MARIA]: 'Maria Silva' });
    const [atividade] = await montarHistorico([evento({ actorId: MARIA, acao: 'catalog.assistant_product_edit' })], p);

    expect(atividade.autor).toMatchObject({ tipo: 'pessoa', userId: MARIA, papel: 'owner' });
    expect(atividade.viaAssistente).toBe(true);
  });

  it('lê cada pessoa uma vez só, mesmo com várias ações dela na página', async () => {
    const { p, lidos, identidades } = portas({ [MARIA]: 'admin' }, { [MARIA]: 'Maria' });
    await montarHistorico([evento({ id: '1', actorId: MARIA }), evento({ id: '2', actorId: MARIA }), evento({ id: '3' })], p);

    expect(lidos).toEqual([[MARIA]]);
    expect(identidades).toEqual([MARIA]);
  });

  it('não repassa IP, navegador nem metadata para a tela', async () => {
    const { p } = portas({}, {});
    const [atividade] = await montarHistorico([evento({ metadata: { origem: 'ia', run_id: 'r' } })], p);

    expect(Object.keys(atividade).sort()).toEqual(
      ['acao', 'autor', 'correlationId', 'createdAt', 'descricao', 'gravidade', 'id', 'recurso', 'recursoId', 'viaAssistente'],
    );
    expect(atividadeSchema.safeParse(atividade).success).toBe(true);
  });

  it('ação fora do catálogo mostra o código dela, em vez de sumir', async () => {
    const { p } = portas({}, {});
    const [atividade] = await montarHistorico([evento({ acao: 'evento.novo_desconhecido' })], p);

    expect(atividade.descricao).toBe('evento.novo_desconhecido');
    expect(atividade.gravidade).toBe('info');
  });

  it('traz a severidade do catálogo, para a tela destacar o que pede conferência', async () => {
    const { p } = portas({}, {});
    const [atividade] = await montarHistorico([evento({ acao: 'order.manual_sale_unresolved' })], p);

    expect(atividade.gravidade).toBe('critical');
  });
});
