import { afterEach, describe, expect, it, vi } from 'vitest';

import { construirPassos, lerArgumentos, resumir } from './verificar-jornada-bling.mjs';

interface Passo {
  nome: string;
  porque: string;
  executar: () => Promise<{ estado: string; detalhe: string }>;
}

function respostaJson(corpo: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(corpo),
  } as Response;
}

/** Encontra um passo pelo trecho do nome, para o teste não depender da ordem. */
function passo(passos: Passo[], trecho: string): Passo {
  const encontrado = passos.find((p) => p.nome.includes(trecho));
  if (!encontrado) throw new Error(`passo não encontrado: ${trecho}`);
  return encontrado;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('leitura de argumentos', () => {
  it('não escreve nada por padrão', () => {
    expect(lerArgumentos(['--token', 'abc']).escrever).toBe(false);
  });

  it('só habilita escrita com --escrever explícito', () => {
    expect(lerArgumentos(['--token', 'abc', '--escrever']).escrever).toBe(true);
  });

  it('lê cliente, produto e quantidade da jornada de escrita', () => {
    const args = lerArgumentos(['--cliente', 'c-1', '--produto', 'p-1', '--quantidade', '3']);
    expect(args).toMatchObject({ clienteId: 'c-1', produtoId: 'p-1', quantidade: 3 });
  });
});

describe('resumo de resposta', () => {
  it('prefere a mensagem de erro do servidor ao JSON cru', () => {
    expect(resumir({ success: false, error: 'Bling não conectado' })).toBe('Bling não conectado');
  });

  it('preserva corpo em texto, que é o sinal de erro de plataforma', () => {
    expect(resumir('<html>502</html>')).toContain('502');
  });
});

describe('URL de retorno do OAuth', () => {
  it('reprova host de preview, que quebra no deploy seguinte', async () => {
    const estado = { saude: { bling_callback_url: 'https://orbita-abc123.vercel.app/api/bling/callback' } };
    const passos = construirPassos({ base: 'https://x.test', token: 't', escrever: false, estado }) as Passo[];

    const resultado = await passo(passos, 'origem estável').executar();

    expect(resultado.estado).toBe('FALHOU');
    expect(resultado.detalhe).toContain('preview');
  });

  it('aprova o domínio próprio', async () => {
    const estado = { saude: { bling_callback_url: 'https://orbita.mkautobots.site/api/bling/callback' } };
    const passos = construirPassos({ base: 'https://x.test', token: 't', escrever: false, estado }) as Passo[];

    expect((await passo(passos, 'origem estável').executar()).estado).toBe('PASSOU');
  });

  it('reprova quando o servidor não informa a URL', async () => {
    const passos = construirPassos({ base: 'https://x.test', token: 't', escrever: false, estado: { saude: {} } }) as Passo[];
    const resultado = await passo(passos, 'origem estável').executar();

    expect(resultado.estado).toBe('FALHOU');
    expect(resultado.detalhe).toContain('APP_BASE_URL');
  });
});

describe('passo 1 das credenciais', () => {
  it('reprova quando o Client ID não está gravado', async () => {
    const estado = { saude: { conexoes: [{ provedor: 'bling', id: 'c1', credenciais_configuradas: false }] } };
    const passos = construirPassos({ base: 'https://x.test', token: 't', escrever: false, estado }) as Passo[];

    const resultado = await passo(passos, 'passo 1').executar();

    expect(resultado.estado).toBe('FALHOU');
    expect(resultado.detalhe).toContain('Passo 1');
  });
});

describe('recusa de escopo do Bling', () => {
  it('aponta plano e escopos quando o provedor responde forbidden', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaJson(
      { success: false, error: 'O Bling recusou a autorização. (forbidden) O usuário não possui autorização' },
      400,
    )));
    const passos = construirPassos({ base: 'https://x.test', token: 't', escrever: false, estado: {} }) as Passo[];

    const resultado = await passo(passos, 'passo 2').executar();

    expect(resultado.estado).toBe('FALHOU');
    expect(resultado.detalhe).toContain('plano da conta');
  });
});

describe('criação do pedido', () => {
  it('não cria nada sem --escrever', async () => {
    const chamadas = vi.fn();
    vi.stubGlobal('fetch', chamadas);
    const passos = construirPassos({
      base: 'https://x.test', token: 't', escrever: false, estado: { blingVivo: true },
      clienteId: 'c', produtoId: 'p',
    }) as Passo[];

    const resultado = await passo(passos, 'criar pedido manual').executar();

    expect(resultado.estado).toBe('PULADO');
    expect(chamadas).not.toHaveBeenCalled();
  });

  it('envia o corpo do contrato único, sem total ditado pelo cliente', async () => {
    let corpoEnviado: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opcoes: RequestInit) => {
      corpoEnviado = JSON.parse(String(opcoes.body));
      return respostaJson({ success: true, pedidoId: 'local-1', blingPedidoId: '918273', total: 99.8, avisos: [] });
    }));

    const passos = construirPassos({
      base: 'https://x.test', token: 't', escrever: true, estado: { blingVivo: true },
      clienteId: 'c-1', produtoId: 'p-1', quantidade: 2,
    }) as Passo[];

    const resultado = await passo(passos, 'criar pedido manual').executar();

    expect(resultado.estado).toBe('PASSOU');
    expect(corpoEnviado).toMatchObject({ syncBling: true, clienteId: 'c-1' });
    expect('total' in corpoEnviado).toBe(false);
  });

  it('reprova quando a venda foi gravada mas o Bling não devolveu id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respostaJson({ success: true, pedidoId: 'local-1', blingPedidoId: null })));

    const passos = construirPassos({
      base: 'https://x.test', token: 't', escrever: true, estado: { blingVivo: true },
      clienteId: 'c-1', produtoId: 'p-1',
    }) as Passo[];

    const resultado = await passo(passos, 'criar pedido manual').executar();

    expect(resultado.estado).toBe('FALHOU');
    expect(resultado.detalhe).toContain('sincronização não aconteceu');
  });
});
