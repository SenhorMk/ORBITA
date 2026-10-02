import { beforeEach, describe, expect, it } from 'vitest';

import type { EscritaRemota, LeituraRemota, ProdutoRemoto } from '@/lib/integrations/bling/operacaoRemotaContract';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';
import type { ProdutoComFoto } from '@/repositories/produtoImagemRepository';

import {
  estadoAposSincronizacao,
  sincronizarFotoComBling,
  type EventoDaSincronizacao,
  type FotoNoBlingPort,
  type SincronizacaoDaFotoDeps,
} from './sincronizacaoDaFotoComBling';

const ORG = '11111111-1111-4111-8111-111111111111';
const OUTRA_ORG = '99999999-9999-4999-8999-999999999999';
const PRODUTO = '33333333-3333-4333-8333-333333333333';
const BLING_ID = '16714230397';
const foto = (letra: string) => `${ORG}/${PRODUTO}/${letra.repeat(8)}-${letra.repeat(4)}-4${letra.repeat(3)}-8${letra.repeat(3)}-${letra.repeat(12)}.png`;
const A = foto('a');
const B = foto('b');

/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const escopo = (organizationId: string) => ({ organizationId, actorId: ORG, role: 'owner' } as unknown as VerifiedOrganizationScope);

/**
 * O Bling como a Fase A o caracterizou (2026-10-02): a escrita é aceita na
 * hora e o efeito só aparece depois (`atraso` leituras); `[]` apaga tudo;
 * importar acrescenta ao fim, com deduplicação pelo objeto de origem. As
 * imagens ficam identificadas pelo caminho que a URL assinada aponta.
 */
function blingFalso(inicial: string[], opcoes: {
  atraso?: number;
  falharLimpeza?: EscritaRemota;
  falharImportacao?: EscritaRemota;
  importacaoSomeEmSilencio?: boolean;
  nuncaProcessa?: boolean;
  terceiraImagemAposImportar?: boolean;
} = {}) {
  const estado = { imagens: [...inicial], leituras: 0 };
  const chamadas: string[] = [];
  const urls: string[] = [];
  let pendentes: Array<{ em: number; efeito: () => void }> = [];
  const atraso = opcoes.atraso ?? 1;
  const agendar = (efeito: () => void) => {
    if (!opcoes.nuncaProcessa) pendentes.push({ em: estado.leituras + atraso, efeito });
  };
  const porta: FotoNoBlingPort = {
    async consultarProduto(id): Promise<LeituraRemota<ProdutoRemoto>> {
      chamadas.push('ler');
      estado.leituras++;
      const prontos = pendentes.filter((p) => p.em <= estado.leituras);
      pendentes = pendentes.filter((p) => p.em > estado.leituras);
      prontos.forEach((p) => p.efeito());
      return { _tag: 'RemotoPresente', valor: { id, imagens: estado.imagens.length } };
    },
    async limparImagensDoProduto() {
      chamadas.push('limpar');
      if (opcoes.falharLimpeza) return opcoes.falharLimpeza;
      agendar(() => { estado.imagens = []; });
      return { _tag: 'EscritaAceita' };
    },
    async importarImagemDoProduto(_id, url) {
      chamadas.push('importar');
      urls.push(url);
      if (opcoes.falharImportacao) return opcoes.falharImportacao;
      const chave = new URL(url).pathname.replace('/sign/', '');
      agendar(() => {
        if (opcoes.importacaoSomeEmSilencio) return;
        if (!estado.imagens.includes(chave)) estado.imagens.push(chave);
        if (opcoes.terceiraImagemAposImportar) estado.imagens.push('imagem-de-terceiro');
      });
      return { _tag: 'EscritaAceita' };
    },
  };
  return { porta, estado, chamadas, urls };
}

/** A linha do banco: o produto e o lease (colunas da migration 72). */
interface Linha { organizacao: string; produto: ProdutoComFoto; lease?: { token: string; expiraEm: number } | null }

const TTL_MS = 90_000;

let linhas: Linha[];
let tempo: number;
let aoEsperar: (() => void) | null;
let auditados: EventoDaSincronizacao[];
let bling: ReturnType<typeof blingFalso>;
let assinaturas: string[];

function linha(): ProdutoComFoto {
  return linhas.find((l) => l.organizacao === ORG && l.produto.id === PRODUTO)!.produto;
}
function mudarLinha(campos: Partial<ProdutoComFoto>) {
  const l = linhas.find((x) => x.organizacao === ORG && x.produto.id === PRODUTO)!;
  l.produto = { ...l.produto, ...campos };
}

let tokens: number;
const acharLinha = (scope: VerifiedOrganizationScope, id: string) =>
  linhas.find((l) => l.organizacao === scope.organizationId && l.produto.id === id);
function lease() { return linhas.find((x) => x.organizacao === ORG && x.produto.id === PRODUTO)!.lease ?? null; }

function deps(overrides: Partial<SincronizacaoDaFotoDeps> = {}): SincronizacaoDaFotoDeps {
  return {
    carregar: async (scope, id) => acharLinha(scope, id)?.produto ?? null,
    // As funções SQL do lease: aquisição só sem lease vigente; liberação só pelo próprio token.
    adquirirLease: async (scope, id, token) => {
      const l = acharLinha(scope, id);
      if (!l || (l.lease && l.lease.expiraEm > tempo)) return false;
      l.lease = { token, expiraEm: tempo + TTL_MS };
      return true;
    },
    liberarLease: async (scope, id, token) => {
      const l = acharLinha(scope, id);
      if (!l?.lease || l.lease.token !== token) return false;
      l.lease = null;
      return true;
    },
    // O compare-and-set do repositório: só marca se o desejado ainda for o mesmo e o lease ainda for deste token.
    confirmar: async (scope, id, desejado, token) => {
      const l = acharLinha(scope, id);
      if (!l || l.produto.imagemStoragePath !== desejado || l.lease?.token !== token) return false;
      l.produto = { ...l.produto, imagemBlingSyncPath: desejado };
      return true;
    },
    novoToken: () => `lease-${++tokens}`,
    bling: () => bling.porta,
    assinarImportacao: async (caminho) => {
      assinaturas.push(caminho);
      return `https://storage.test/sign/${caminho}?token=capacidade-temporaria-${assinaturas.length}`;
    },
    auditar: async (_scope, evento) => { auditados.push(evento); },
    esperar: async (ms) => { tempo += ms; aoEsperar?.(); },
    agora: () => tempo,
    orcamentoMs: 40_000,
    intervaloMs: 2_000,
    ...overrides,
  };
}

const sincronizar = (d = deps(), organizacao = ORG) => sincronizarFotoComBling(escopo(organizacao), PRODUTO, 'corr-1', d);

beforeEach(() => {
  linhas = [{ organizacao: ORG, produto: { id: PRODUTO, blingId: BLING_ID, imagemStoragePath: A, imagemBlingSyncPath: null, imagemDoBling: null } }];
  tempo = 0;
  tokens = 0;
  aoEsperar = null;
  auditados = [];
  assinaturas = [];
  bling = blingFalso(['antiga-1', 'antiga-2']);
});

describe('convergência: o Bling termina com exatamente a foto do ORBITA', () => {
  it('adicionar A: limpa as antigas, confirma vazio, importa A, confirma uma e só então marca A', async () => {
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([A]);
    expect(linha().imagemBlingSyncPath).toBe(A);
    // Ordem: limpar → ler até 0 → importar → ler até 1.
    const sem = bling.chamadas.filter((c, i, todas) => !(c === 'ler' && todas[i - 1] === 'ler'));
    expect(sem).toEqual(['limpar', 'ler', 'importar', 'ler']);
    expect(assinaturas).toEqual([A]);
    expect(auditados.map((e) => e.acao)).toEqual(['catalog.product_image_bling_synced']);
    expect(auditados[0]!.metadata).toEqual({ produto_id: PRODUTO, operacao: 'adicionar', havia_sincronizacao_anterior: false, resultado: 'sincronizada' });
  });

  it('trocar A → B: no fim só B', async () => {
    bling = blingFalso([A]);
    mudarLinha({ imagemStoragePath: B, imagemBlingSyncPath: A });
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([B]);
    expect(linha().imagemBlingSyncPath).toBe(B);
    expect(auditados[0]!.metadata.operacao).toBe('trocar');
  });

  it('remover: o Bling fica sem imagens e o marcador volta a null, sem assinar nem importar nada', async () => {
    bling = blingFalso([B]);
    mudarLinha({ imagemStoragePath: null, imagemBlingSyncPath: B });
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([]);
    expect(linha().imagemBlingSyncPath).toBeNull();
    expect(bling.chamadas).not.toContain('importar');
    expect(assinaturas).toEqual([]);
    expect(auditados[0]!.metadata.operacao).toBe('remover');
  });

  it('processamento assíncrono: o efeito só aparece depois de várias leituras, e ainda converge', async () => {
    bling = blingFalso(['antiga'], { atraso: 4 });
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([A]);
    expect(bling.chamadas.filter((c) => c === 'ler').length).toBeGreaterThanOrEqual(8);
  });
});

describe('nada a fazer', () => {
  it('produto que o ORBITA nunca adotou: as imagens do Bling ficam intocadas', async () => {
    mudarLinha({ imagemStoragePath: null, imagemBlingSyncPath: null });
    expect(await sincronizar()).toEqual({ _tag: 'SemFoto' });
    expect(bling.chamadas).toEqual([]);
    expect(bling.estado.imagens).toEqual(['antiga-1', 'antiga-2']);
  });

  it('já sincronizada: nenhuma chamada ao Bling', async () => {
    mudarLinha({ imagemBlingSyncPath: A });
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: true });
    expect(bling.chamadas).toEqual([]);
  });

  it('produto sem bling_id: pendente de vínculo, sem chamada, sem busca por nome ou SKU', async () => {
    mudarLinha({ blingId: null });
    expect(await sincronizar()).toEqual({ _tag: 'SemVinculo' });
    expect(bling.chamadas).toEqual([]);
    expect(auditados.map((e) => e.acao)).toEqual(['catalog.product_image_bling_sync_pending']);
  });

  it('produto de outra organização é inexistente: nenhuma chamada ao Bling', async () => {
    expect(await sincronizar(deps(), OUTRA_ORG)).toEqual({ _tag: 'NaoEncontrado' });
    expect(bling.chamadas).toEqual([]);
  });
});

describe('falhas: a foto local fica, o estado fica pendente', () => {
  it('falha na limpeza (400): nada importado, marcador intacto, sem corpo remoto', async () => {
    bling = blingFalso(['antiga'], { falharLimpeza: { _tag: 'RemotoRecusou', status: 400 } });
    const r = await sincronizar();
    expect(r).toEqual({ _tag: 'Falhou', etapa: 'limpar', motivo: 'recusado' });
    expect(linha()).toMatchObject({ imagemStoragePath: A, imagemBlingSyncPath: null });
    expect(bling.chamadas).not.toContain('importar');
    expect(auditados[0]).toMatchObject({ acao: 'catalog.product_image_bling_sync_failed', metadata: { etapa: 'limpar', motivo: 'recusado' } });
  });

  it.each([
    [{ _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' } as const, 'indeterminado'],
    [{ _tag: 'RemotoLimitado' } as const, 'limitado'],
    [{ _tag: 'RemotoIndeterminado', causa: 'falha_de_rede' } as const, 'indeterminado'],
  ])('falha na importação depois de limpar (%o): Bling vazio, foto local mantida, pendente', async (falha, motivo) => {
    bling = blingFalso(['antiga'], { falharImportacao: falha });
    expect(await sincronizar()).toEqual({ _tag: 'Falhou', etapa: 'importar', motivo });
    expect(bling.estado.imagens).toEqual([]);
    expect(linha()).toMatchObject({ imagemStoragePath: A, imagemBlingSyncPath: null });
    expect(estadoAposSincronizacao({ _tag: 'Falhou', etapa: 'importar', motivo: 'indeterminado' })).toBe('pendente');
  });

  it('prazo: o Bling nunca processa — para dentro do orçamento, sem marcar nada', async () => {
    bling = blingFalso(['antiga'], { nuncaProcessa: true });
    expect(await sincronizar()).toEqual({ _tag: 'Falhou', etapa: 'confirmar_vazio', motivo: 'prazo_esgotado' });
    expect(tempo).toBeLessThanOrEqual(40_000);
    expect(linha().imagemBlingSyncPath).toBeNull();
  });

  it('a releitura é a prova: importação aceita que não aparece no Bling não é marcada', async () => {
    bling = blingFalso(['antiga'], { importacaoSomeEmSilencio: true });
    expect(await sincronizar()).toEqual({ _tag: 'Falhou', etapa: 'confirmar_importacao', motivo: 'prazo_esgotado' });
    expect(linha().imagemBlingSyncPath).toBeNull();
  });

  it('mais de uma imagem depois de importar não é "exatamente uma": não marca', async () => {
    bling = blingFalso(['antiga'], { terceiraImagemAposImportar: true });
    expect(await sincronizar()).toEqual({ _tag: 'Falhou', etapa: 'confirmar_importacao', motivo: 'quantidade_inesperada' });
    expect(linha().imagemBlingSyncPath).toBeNull();
  });

  it('Storage indisponível para assinar: pendente, nada importado', async () => {
    expect(await sincronizar(deps({ assinarImportacao: async () => null }))).toEqual({ _tag: 'Falhou', etapa: 'assinar', motivo: 'armazenamento_indisponivel' });
    expect(bling.chamadas).not.toContain('importar');
  });

  it('produto apagado no Bling: ausente, sem marcar', async () => {
    bling = blingFalso(['antiga'], { falharLimpeza: { _tag: 'RemotoAusente' } });
    expect(await sincronizar()).toEqual({ _tag: 'Falhou', etapa: 'limpar', motivo: 'produto_ausente_no_bling' });
  });
});

describe('retry e idempotência', () => {
  it('retry depois de falha na importação converge, sem novo upload (o objeto vem do banco)', async () => {
    bling = blingFalso(['antiga'], { falharImportacao: { _tag: 'RemotoIndeterminado', causa: 'erro_do_servidor' } });
    await sincronizar();
    const estadoDoBling = bling.estado.imagens;
    bling = blingFalso(estadoDoBling);
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([A]);
    expect(assinaturas).toEqual([A, A]);
  });

  it('repetir a convergência inteira deixa o mesmo estado observável: uma A, nunca duas', async () => {
    await sincronizar();
    mudarLinha({ imagemBlingSyncPath: null }); // força a repetição completa
    await sincronizar();
    expect(bling.estado.imagens).toEqual([A]);
    expect(linha().imagemBlingSyncPath).toBe(A);
  });

  it('dois retries simultâneos: um adquire o lease e converge; o outro devolve EmAndamento sem tocar no Bling', async () => {
    const chamadasDoSegundo: string[] = [];
    const [r1, r2] = await Promise.all([sincronizar(), sincronizar(deps({ bling: () => espiar(bling.porta, chamadasDoSegundo) }))]);
    expect(r1).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(r2).toEqual({ _tag: 'EmAndamento' });
    expect(chamadasDoSegundo).toEqual([]);
    expect(bling.estado.imagens).toEqual([A]);
    expect(lease()).toBeNull();
  });
});

describe('concorrência: uma sincronização atrasada nunca marca outra foto', () => {
  // O Bling falso demora 3 leituras: há esperas em que o usuário consegue agir.
  beforeEach(() => { bling = blingFalso(['antiga'], { atraso: 3 }); });

  it('A ainda sincronizando, usuário troca para B: A termina e NÃO marca nada', async () => {
    aoEsperar = () => { if (bling.chamadas.includes('importar')) mudarLinha({ imagemStoragePath: B }); };
    expect(await sincronizar()).toEqual({ _tag: 'Obsoleta' });
    expect(linha()).toMatchObject({ imagemStoragePath: B, imagemBlingSyncPath: null });
    expect(auditados.map((e) => e.acao)).not.toContain('catalog.product_image_bling_synced');
    // A sincronização de B corrige o Bling.
    aoEsperar = null;
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([B]);
    expect(linha().imagemBlingSyncPath).toBe(B);
  });

  it('A ainda sincronizando, usuário remove a foto: A termina e NÃO marca; a remoção converge depois', async () => {
    // A remoção de uma foto ainda não confirmada grava A como pendente no
    // Bling (`trocarCaminho` com `pendenteNoBling`, testado na rota).
    aoEsperar = () => { if (bling.chamadas.includes('importar')) mudarLinha({ imagemStoragePath: null, imagemBlingSyncPath: A }); };
    expect(await sincronizar()).toEqual({ _tag: 'Obsoleta' });
    expect(linha()).toMatchObject({ imagemStoragePath: null, imagemBlingSyncPath: A });
    aoEsperar = null;
    // A remoção converge: o Bling fica sem a A que a execução atrasada importou, e a foto local não volta.
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([]);
    expect(linha()).toMatchObject({ imagemStoragePath: null, imagemBlingSyncPath: null });
  });

  it('troca durante a espera do vazio: a execução de A não marca', async () => {
    aoEsperar = () => { if (!bling.chamadas.includes('importar')) mudarLinha({ imagemStoragePath: B }); };
    expect(await sincronizar()).toEqual({ _tag: 'Obsoleta' });
    expect(linha().imagemBlingSyncPath).toBeNull();
  });
});

/** Repassa a porta do Bling registrando cada chamada desta execução. */
function espiar(porta: FotoNoBlingPort, chamadas: string[]): FotoNoBlingPort {
  return {
    consultarProduto: (id) => { chamadas.push('ler'); return porta.consultarProduto(id); },
    limparImagensDoProduto: (id) => { chamadas.push('limpar'); return porta.limparImagensDoProduto(id); },
    importarImagemDoProduto: (id, url) => { chamadas.push('importar'); return porta.importarImagemDoProduto(id, url); },
  };
}

describe('lease por produto: nenhuma escrita no Bling sem o lease', () => {
  it('corrida A/B: B concorrente não toca no Bling enquanto A tem o lease; o retry de B termina com exatamente [B]', async () => {
    // A já limpou e confirmou o vazio; entre assinar e importar, o usuário troca
    // para B e a sincronização de B roda INTEIRA. Depois A importa A. Sem lease,
    // B convergia e marcava B, e A acrescentava A: o Bling ficava [B, A] com o
    // banco dizendo "B sincronizada" — e o retry de B não fazia nada.
    const chamadasDeB: string[] = [];
    let desfechoDeB: Awaited<ReturnType<typeof sincronizar>> | null = null;
    const depsDeA = deps({
      assinarImportacao: async (caminho) => {
        mudarLinha({ imagemStoragePath: B });
        desfechoDeB = await sincronizar(deps({ bling: () => espiar(bling.porta, chamadasDeB) }));
        return `https://storage.test/sign/${caminho}?token=capacidade-temporaria-a`;
      },
    });
    const desfechoDeA = await sincronizar(depsDeA);
    const retryDeB = await sincronizar();

    expect(bling.estado.imagens).toEqual([B]);
    expect(linha().imagemBlingSyncPath).toBe(B);
    expect(desfechoDeA).toEqual({ _tag: 'Obsoleta' });
    expect(desfechoDeB).toEqual({ _tag: 'EmAndamento' });
    expect(chamadasDeB).toEqual([]);
    expect(retryDeB).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(lease()).toBeNull();
  });

  it('lease vigente de outra execução não é roubado: EmAndamento, sem chamada ao Bling', async () => {
    linhas[0]!.lease = { token: 'outra-execucao', expiraEm: tempo + 1_000 };
    expect(await sincronizar()).toEqual({ _tag: 'EmAndamento' });
    expect(bling.chamadas).toEqual([]);
    expect(lease()).toEqual({ token: 'outra-execucao', expiraEm: 1_000 });
  });

  it('lease expirado (a execução que o tinha morreu) é recuperado e a sincronização converge', async () => {
    linhas[0]!.lease = { token: 'execucao-morta', expiraEm: tempo };
    expect(await sincronizar()).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([A]);
    expect(lease()).toBeNull();
  });

  it('execução que perdeu o lease não confirma nem libera o lease do novo dono', async () => {
    bling = blingFalso(['antiga'], { atraso: 3 });
    aoEsperar = () => { if (bling.chamadas.includes('importar')) linhas[0]!.lease = { token: 'novo-dono', expiraEm: tempo + TTL_MS }; };
    expect(await sincronizar()).toEqual({ _tag: 'Obsoleta' });
    expect(linha().imagemBlingSyncPath).toBeNull();
    expect(lease()?.token).toBe('novo-dono');
  });

  it('exceção no meio da convergência libera o lease em finally', async () => {
    const quebrada: FotoNoBlingPort = { ...bling.porta, limparImagensDoProduto: async () => { throw new Error('socket hang up'); } };
    await expect(sincronizar(deps({ bling: () => quebrada }))).rejects.toThrow('socket hang up');
    expect(lease()).toBeNull();
  });

  it('falha ao liberar não derruba a sincronização: o lease expira sozinho', async () => {
    const r = await sincronizar(deps({ liberarLease: async () => { throw new Error('banco fora'); } }));
    expect(r).toEqual({ _tag: 'Sincronizada', jaEstava: false });
  });

  it('outra organização não adquire o lease nem toca no Bling', async () => {
    expect(await sincronizar(deps(), OUTRA_ORG)).toEqual({ _tag: 'NaoEncontrado' });
    expect(await deps().adquirirLease(escopo(OUTRA_ORG), PRODUTO, 'intruso')).toBe(false);
    expect(lease()).toBeNull();
    expect(bling.chamadas).toEqual([]);
  });

  it('relê sob o lease: converge para o desejado atual, não o que viu antes de adquirir', async () => {
    let leituras = 0;
    const r = await sincronizar(deps({
      carregar: async (scope, id) => {
        if (++leituras === 2) mudarLinha({ imagemStoragePath: B });
        return acharLinha(scope, id)?.produto ?? null;
      },
    }));
    expect(r).toEqual({ _tag: 'Sincronizada', jaEstava: false });
    expect(bling.estado.imagens).toEqual([B]);
    expect(linha().imagemBlingSyncPath).toBe(B);
  });

  it('o token do lease não aparece no desfecho nem na auditoria', async () => {
    const r = await sincronizar();
    expect(JSON.stringify(r)).not.toContain('lease-');
    expect(JSON.stringify(auditados)).not.toContain('lease-');
  });
});

describe('o que nunca sai', () => {
  it('URL assinada e token não vão para o banco nem para a auditoria', async () => {
    await sincronizar();
    expect(linha().imagemBlingSyncPath).toBe(A);
    expect(bling.urls[0]).toContain('capacidade-temporaria');
    const auditoria = JSON.stringify(auditados);
    for (const proibido of ['https://', 'token', 'capacidade', A]) expect(auditoria).not.toContain(proibido);
  });
});
