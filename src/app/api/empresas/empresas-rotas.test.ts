import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import type { EmpresaCompleta, EmpresaResumo } from '@/lib/empresas/empresaContract';
import type { RateLimitDecision } from '@/lib/rateLimit';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { createBuscaDeEmpresasHandler, createConsultaPorCnpjHandler, type EmpresasDeps } from './handler';

const ORG = '11111111-1111-4111-8111-111111111111';
const ATOR = '22222222-2222-4222-8222-222222222222';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const scope = { organizationId: ORG, actorId: ATOR, role: 'owner' } as unknown as VerifiedOrganizationScope;
const CNPJ = '11222333000181';

const EMPRESA: EmpresaCompleta = {
  cnpj: CNPJ, razaoSocial: 'EMPRESA EXEMPLO LTDA', nomeFantasia: 'EMPRESA EXEMPLO', situacao: 'ATIVA',
  email: 'contato@exemplo.com.br', telefone: '4232220000', cep: '84010000', logradouro: 'RUA XV', numero: '100',
  bairro: 'CENTRO', municipio: 'PONTA GROSSA', uf: 'PR',
};
const resumo = (i: number): EmpresaResumo => ({
  cnpj: String(i).padStart(14, '0'), razaoSocial: `EMPRESA ${i} LTDA`, nomeFantasia: null, municipio: 'CURITIBA', uf: 'PR', situacao: 'ATIVA',
});

const LIVRE: RateLimitDecision = { _tag: 'RateLimitAllowed', remaining: 9, resetAt: 0 };

function deps(overrides: Partial<EmpresasDeps> = {}) {
  const chaves: string[] = [];
  const falhas: Array<{ operacao: string; causa: string; organizacaoId: string }> = [];
  const d: EmpresasDeps = {
    autorizar: async () => ({ _tag: 'Autorizado', scope }),
    limitar: async (acao, chave) => { chaves.push(`${acao}|${chave}`); return LIVRE; },
    consultarCnpj: async () => ({ _tag: 'EmpresaEncontrada', empresa: EMPRESA }),
    provedor: () => ({ buscar: async () => [resumo(1)] }),
    registrarFalha: (operacao, causa, organizacaoId) => { falhas.push({ operacao, causa, organizacaoId }); },
    ...overrides,
  };
  return { d, chaves, falhas };
}

const pedido = (url: string) => new Request(`https://orbita.test${url}`);
async function json(r: Response) { return { status: r.status, corpo: await r.json() }; }

describe('autenticação e tenant', () => {
  it('sem sessão: a resposta da autorização volta como está, e nada é consultado', async () => {
    const consultarCnpj = vi.fn();
    const buscar = vi.fn();
    const negar = async () => ({ _tag: 'Negado' as const, response: NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 }) });
    const { d } = deps({ autorizar: negar, consultarCnpj, provedor: () => ({ buscar }) });
    expect((await createConsultaPorCnpjHandler(d)(pedido(`/api/empresas/cnpj/${CNPJ}`), CNPJ)).status).toBe(401);
    expect((await createBuscaDeEmpresasHandler(d)(pedido('/api/empresas/busca?termo=empresa'))).status).toBe(401);
    expect(consultarCnpj).not.toHaveBeenCalled();
    expect(buscar).not.toHaveBeenCalled();
  });

  it('o limite é por pessoa da organização VERIFICADA; organização na query não muda nada', async () => {
    const { d, chaves } = deps();
    await createBuscaDeEmpresasHandler(d)(pedido(`/api/empresas/busca?termo=empresa&organizacao=${'9'.repeat(8)}`));
    await createConsultaPorCnpjHandler(d)(pedido(`/api/empresas/cnpj/${CNPJ}?organizationId=outra`), CNPJ);
    expect(chaves).toEqual([`empresa_busca|${ORG}:${ATOR}`, `empresa_cnpj|${ORG}:${ATOR}`]);
  });
});

describe('GET /api/empresas/cnpj/[cnpj]', () => {
  it('encontrada: 200 com a empresa completa', async () => {
    const { d } = deps();
    expect(await json(await createConsultaPorCnpjHandler(d)(pedido(`/api/empresas/cnpj/${CNPJ}`), CNPJ)))
      .toEqual({ status: 200, corpo: { resultado: 'EmpresaEncontrada', empresa: EMPRESA } });
  });

  it('não encontrada 404, inválido 400, indisponível 503 (com log só da categoria)', async () => {
    const casos = [
      [{ _tag: 'EmpresaNaoEncontrada' as const }, 404, 'EmpresaNaoEncontrada'],
      [{ _tag: 'CnpjInvalido' as const }, 400, 'CnpjInvalido'],
      [{ _tag: 'ConsultaIndisponivel' as const, causa: 'http_502' }, 503, 'ConsultaIndisponivel'],
    ] as const;
    for (const [desfecho, status, resultado] of casos) {
      const { d, falhas } = deps({ consultarCnpj: async () => desfecho });
      expect(await json(await createConsultaPorCnpjHandler(d)(pedido('/x'), CNPJ))).toEqual({ status, corpo: { resultado } });
      if (status === 503) expect(falhas).toEqual([{ operacao: 'empresas.consulta_cnpj', causa: 'http_502', organizacaoId: ORG }]);
    }
  });

  it('rate limit: estourado 429; armazenamento indisponível 503 (falha fechada); nada é consultado', async () => {
    const consultarCnpj = vi.fn();
    const bloqueado = deps({ consultarCnpj, limitar: async () => ({ _tag: 'RateLimitBlocked', retryAfterMs: 1000, resetAt: 0 }) });
    expect((await createConsultaPorCnpjHandler(bloqueado.d)(pedido('/x'), CNPJ)).status).toBe(429);
    const fora = deps({ consultarCnpj, limitar: async () => ({ _tag: 'RateLimitStoreUnavailable', cause: 'rpc' }) });
    expect((await createConsultaPorCnpjHandler(fora.d)(pedido('/x'), CNPJ)).status).toBe(503);
    expect(consultarCnpj).not.toHaveBeenCalled();
  });
});

describe('GET /api/empresas/busca', () => {
  it('termo curto ou longo: 400, sem chamar o provedor', async () => {
    const buscar = vi.fn();
    const { d } = deps({ provedor: () => ({ buscar }) });
    expect((await createBuscaDeEmpresasHandler(d)(pedido('/api/empresas/busca?termo=ab'))).status).toBe(400);
    expect((await createBuscaDeEmpresasHandler(d)(pedido(`/api/empresas/busca?termo=${'x'.repeat(81)}`))).status).toBe(400);
    expect(buscar).not.toHaveBeenCalled();
  });

  it('sem provedor configurado: BuscaPorNomeIndisponivel (200), e nada quebra', async () => {
    const { d } = deps({ provedor: () => null });
    expect(await json(await createBuscaDeEmpresasHandler(d)(pedido('/api/empresas/busca?termo=empresa'))))
      .toEqual({ status: 200, corpo: { resultado: 'BuscaPorNomeIndisponivel' } });
  });

  it('resultados: no máximo 8; vazio é lista vazia', async () => {
    const { d } = deps({ provedor: () => ({ buscar: async () => Array.from({ length: 12 }, (_, i) => resumo(i + 1)) }) });
    const r = await json(await createBuscaDeEmpresasHandler(d)(pedido('/api/empresas/busca?termo=empresa')));
    expect(r.corpo.empresas).toHaveLength(8);
    const vazio = deps({ provedor: () => ({ buscar: async () => [] }) });
    expect((await json(await createBuscaDeEmpresasHandler(vazio.d)(pedido('/api/empresas/busca?termo=nada')))).corpo)
      .toEqual({ resultado: 'Empresas', empresas: [] });
  });

  it('erro do provedor: 503, e o log não leva o termo nem a mensagem do provedor', async () => {
    const { d, falhas } = deps({ provedor: () => ({ buscar: async () => { throw new TypeError('chave sk_live_123 recusada para "padaria do joão"'); } }) });
    expect((await createBuscaDeEmpresasHandler(d)(pedido('/api/empresas/busca?termo=padaria%20do%20jo%C3%A3o'))).status).toBe(503);
    expect(falhas).toEqual([{ operacao: 'empresas.busca', causa: 'TypeError', organizacaoId: ORG }]);
  });
});

describe('o segredo do provedor nunca chega ao navegador', () => {
  const raiz = path.resolve(__dirname, '../../../..');
  const arquivos = (dir: string): string[] => readdirSync(dir).flatMap((nome) => {
    const completo = path.join(dir, nome);
    return statSync(completo).isDirectory() ? arquivos(completo) : /\.tsx?$/u.test(nome) && !/\.test\.tsx?$/u.test(nome) ? [completo] : [];
  });

  it('código de componente não importa o lado servidor da busca nem lê variável de ambiente para isso', () => {
    for (const arquivo of arquivos(path.join(raiz, 'src/components'))) {
      const fonte = readFileSync(arquivo, 'utf8');
      expect(fonte, arquivo).not.toContain('services/empresas');
      expect(fonte, arquivo).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(BRASILAPI|EMPRESA|CNPJ)/u);
    }
  });
});
