import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

import type { EmpresaCompleta } from '@/lib/empresas/empresaContract';
import type { RateLimitDecision } from '@/lib/rateLimit';
import type { VerifiedOrganizationScope } from '@/lib/verifiedOrganizationScope';

import { createConsultaPorCnpjHandler, type EmpresasDeps } from './handler';

const ORG = '11111111-1111-4111-8111-111111111111';
const ATOR = '22222222-2222-4222-8222-222222222222';
/** SAFETY: o escopo é entrada do teste, não o que está sob teste. */
const escopo = (role: 'owner' | 'admin' | 'member') => ({ organizationId: ORG, actorId: ATOR, role }) as unknown as VerifiedOrganizationScope;
const CNPJ = '11222333000181';

const EMPRESA: EmpresaCompleta = {
  cnpj: CNPJ, razaoSocial: 'EMPRESA EXEMPLO LTDA', nomeFantasia: 'EMPRESA EXEMPLO', situacao: 'ATIVA',
  email: 'contato@exemplo.com.br', telefone: '4232220000', cep: '84010000', logradouro: 'RUA XV', numero: '100',
  bairro: 'CENTRO', municipio: 'PONTA GROSSA', uf: 'PR',
};

const LIVRE: RateLimitDecision = { _tag: 'RateLimitAllowed', remaining: 9, resetAt: 0 };

function deps(overrides: Partial<EmpresasDeps> = {}, role: 'owner' | 'admin' | 'member' = 'owner') {
  const chaves: string[] = [];
  const consultados: string[] = [];
  const falhas: Array<{ operacao: string; causa: string; organizacaoId: string }> = [];
  const d: EmpresasDeps = {
    autorizar: async () => ({ _tag: 'Autorizado', scope: escopo(role) }),
    limitar: async (acao, chave) => { chaves.push(`${acao}|${chave}`); return LIVRE; },
    consultarCnpj: async (cnpj) => { consultados.push(cnpj); return { _tag: 'EmpresaEncontrada', empresa: EMPRESA }; },
    registrarFalha: (operacao, causa, organizacaoId) => { falhas.push({ operacao, causa, organizacaoId }); },
    ...overrides,
  };
  return { d, chaves, consultados, falhas };
}

const pedido = (url = `/api/empresas/cnpj/${CNPJ}`) => new Request(`https://orbita.test${url}`);
async function json(r: Response) { return { status: r.status, corpo: await r.json() }; }

describe('autenticação, permissão e tenant', () => {
  it('sem sessão (ou sem organização): a recusa volta como está, e nada é consultado nem limitado', async () => {
    const negar = async () => ({ _tag: 'Negado' as const, response: NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 }) });
    const { d, chaves, consultados } = deps({ autorizar: negar });
    expect((await createConsultaPorCnpjHandler(d)(pedido(), CNPJ)).status).toBe(401);
    expect(chaves).toEqual([]);
    expect(consultados).toEqual([]);
  });

  it('membro sem `organization:manage` (não pode cadastrar contato): 403 SemPermissao, sem consulta nem rate limit', async () => {
    const { d, chaves, consultados } = deps({}, 'member');
    expect(await json(await createConsultaPorCnpjHandler(d)(pedido(), CNPJ))).toEqual({ status: 403, corpo: { resultado: 'SemPermissao' } });
    expect(chaves).toEqual([]);
    expect(consultados).toEqual([]);
  });

  it('admin e owner podem consultar', async () => {
    for (const role of ['admin', 'owner'] as const) {
      const { d } = deps({}, role);
      expect((await createConsultaPorCnpjHandler(d)(pedido(), CNPJ)).status).toBe(200);
    }
  });

  it('o limite é por pessoa da organização VERIFICADA; organização na query não muda nada', async () => {
    const { d, chaves } = deps();
    await createConsultaPorCnpjHandler(d)(pedido(`/api/empresas/cnpj/${CNPJ}?organizationId=outra`), CNPJ);
    expect(chaves).toEqual([`empresa_cnpj|${ORG}:${ATOR}`]);
  });
});

describe('GET /api/empresas/cnpj/[cnpj]', () => {
  it('encontrada: 200 com a empresa completa; o provedor recebe só dígitos', async () => {
    const { d, consultados } = deps();
    expect(await json(await createConsultaPorCnpjHandler(d)(pedido(), '11.222.333/0001-81')))
      .toEqual({ status: 200, corpo: { resultado: 'EmpresaEncontrada', empresa: EMPRESA } });
    expect(consultados).toEqual([CNPJ]);
  });

  it('CNPJ inválido: 400 antes do rate limit e do provedor', async () => {
    for (const invalido of ['11222333000180', '11111111111111', '1122233300018', 'abc', '']) {
      const { d, chaves, consultados } = deps();
      expect(await json(await createConsultaPorCnpjHandler(d)(pedido(), invalido))).toEqual({ status: 400, corpo: { resultado: 'CnpjInvalido' } });
      expect(chaves).toEqual([]);
      expect(consultados).toEqual([]);
    }
  });

  it('não encontrada 404, indisponível 503 (com log só da categoria)', async () => {
    const naoEncontrada = deps({ consultarCnpj: async () => ({ _tag: 'EmpresaNaoEncontrada' }) });
    expect(await json(await createConsultaPorCnpjHandler(naoEncontrada.d)(pedido(), CNPJ))).toEqual({ status: 404, corpo: { resultado: 'EmpresaNaoEncontrada' } });
    const fora = deps({ consultarCnpj: async () => ({ _tag: 'ConsultaIndisponivel', causa: 'cnpj_divergente' }) });
    expect(await json(await createConsultaPorCnpjHandler(fora.d)(pedido(), CNPJ))).toEqual({ status: 503, corpo: { resultado: 'ConsultaIndisponivel' } });
    expect(fora.falhas).toEqual([{ operacao: 'empresas.consulta_cnpj', causa: 'cnpj_divergente', organizacaoId: ORG }]);
  });

  it('rate limit: estourado 429; armazenamento indisponível 503 (falha fechada); nada é consultado', async () => {
    const consultarCnpj = vi.fn();
    const bloqueado = deps({ consultarCnpj, limitar: async () => ({ _tag: 'RateLimitBlocked', retryAfterMs: 1000, resetAt: 0 }) });
    expect(await json(await createConsultaPorCnpjHandler(bloqueado.d)(pedido(), CNPJ))).toEqual({ status: 429, corpo: { resultado: 'LimiteDeConsultas' } });
    const fora = deps({ consultarCnpj, limitar: async () => ({ _tag: 'RateLimitStoreUnavailable', cause: 'rpc' }) });
    expect(await json(await createConsultaPorCnpjHandler(fora.d)(pedido(), CNPJ))).toEqual({ status: 503, corpo: { resultado: 'ConsultaIndisponivel' } });
    expect(consultarCnpj).not.toHaveBeenCalled();
  });
});

describe('superfície: só consulta por CNPJ, nada de segredo no navegador', () => {
  const raiz = path.resolve(__dirname, '../../../..');
  const arquivos = (dir: string): string[] => readdirSync(dir).flatMap((nome) => {
    const completo = path.join(dir, nome);
    return statSync(completo).isDirectory() ? arquivos(completo) : /\.tsx?$/u.test(nome) && !/\.test\.tsx?$/u.test(nome) ? [completo] : [];
  });

  it('não existe rota de busca por nome', () => {
    expect(existsSync(path.join(raiz, 'src/app/api/empresas/busca/route.ts'))).toBe(false);
  });

  // Escopo: o cadastro de contatos. O Financeiro ainda consulta a BrasilAPI pelo
  // navegador (`LancamentoDeDespesa`); isso fica para o PR do fornecedor.
  it('o cadastro de contatos não importa o lado servidor da consulta nem lê variável pública para isso', () => {
    const doContato = [...arquivos(path.join(raiz, 'src/components/clientes')), path.join(raiz, 'src/components/ClienteEditModal.tsx')];
    for (const arquivo of doContato) {
      const fonte = readFileSync(arquivo, 'utf8');
      expect(fonte, arquivo).not.toContain('services/empresas');
      expect(fonte, arquivo).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(BRASILAPI|EMPRESA|CNPJ)/u);
    }
  });

  it('a consulta não escreve: o handler não recebe porta de banco nem de Bling', () => {
    const fonte = readFileSync(path.join(raiz, 'src/app/api/empresas/handler.ts'), 'utf8')
      + readFileSync(path.join(raiz, 'src/app/api/empresas/dependencias.ts'), 'utf8');
    expect(fonte).not.toMatch(/services\/bling|from\('|\.insert\(|\.update\(|\.upsert\(|\.delete\(/u);
  });
});
