import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');

function ler(relativo: string): string {
  return readFileSync(path.join(SRC, relativo), 'utf8');
}

/**
 * Guardas do Ticket 10b.
 *
 * O caminho legado resolvia a credencial do Bling em `integracoes_bling` por
 * `user_id`. Ele estava quebrado em produção de um jeito que nenhum teste
 * pegava, porque nada exercitava a fronteira banco↔role: `service_role` não
 * tem privilégio algum naquela tabela. Verificado com uma consulta real:
 *
 *   set local role service_role;
 *   select 1 from public.integracoes_bling limit 1;
 *   -- 42501 permission denied for table integracoes_bling
 *
 * O mesmo resultado no laboratório e no staging. Estes testes impedem que o
 * caminho volte.
 */
describe('credencial do Bling vem sempre da organização verificada', () => {
  it('não existe entrada por usuário no cliente do Bling', () => {
    // Sem importar o módulo: ele monta o cliente Supabase na carga e exigiria
    // configuração de ambiente que este teste não deve precisar.
    const fonte = ler('services/bling.ts');
    // Só a menção em comentário (que explica a remoção) pode sobrar; nenhuma
    // declaração nem chamada.
    expect(fonte).not.toContain('static forUser');
    expect(fonte).not.toContain('forUser:');
    expect(fonte).toContain('static forVerifiedOrganization(scope: VerifiedOrganizationScope');
  });

  it('o serviço do Bling não lê mais integracoes_bling', () => {
    expect(ler('services/bling.ts')).not.toContain(".from('integracoes_bling')");
  });

  it('nenhuma rota nem serviço resolve credencial do Bling por usuário', () => {
    // O callback do OAuth ainda **escreve** o espelho legado enquanto a coluna
    // existir; o que não pode voltar é alguém **ler** dali para autenticar.
    const arquivos = [
      'services/bling.ts',
      'services/sync.ts',
      'app/api/bling/callback/route.ts',
    ];
    for (const arquivo of arquivos) {
      const conteudo = ler(arquivo);
      expect(conteudo, `${arquivo} não pode selecionar de integracoes_bling`)
        .not.toContain("integracoes_bling')\n    .select");
    }
  });

  it('nenhuma rota chama o Bling sem escopo verificado', () => {
    const fonte = ler('services/bling.ts');
    // `forVerifiedOrganization` só delega para `forOrganization` com o
    // `organizationId` do escopo provado — não aceita string solta.
    expect(fonte).toContain('BlingClient.forOrganization(scope.organizationId, conexaoId)');
  });
});
