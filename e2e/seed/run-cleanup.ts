/**
 * Limpeza do que uma execução de seed criou no projeto Supabase compartilhado.
 *
 * A decisão de **o que** apagar não mora aqui: mora em
 * `src/lib/e2e/limpezaSegura.ts`, que é puro e coberto por teste. Este arquivo
 * só lê o projeto, pergunta lá o que fazer, e executa o que foi aprovado.
 *
 * Regra: apaga-se o que esta execução criou, provado registro a registro pelo
 * id que o diário guardou. Qualquer divergência **para a limpeza inteira** —
 * não se resolve por aproximação.
 *
 * Uso:
 *   npm run e2e:cleanup -- <diario.json> --simular   (não apaga nada)
 *   npm run e2e:cleanup -- <diario.json>
 */
import { readFileSync } from 'node:fs';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { lerDiario, type DiarioDeExecucao, type RegistroEncontrado } from '../../src/lib/e2e/execucaoSeed';
import {
  descreverSimulacao,
  limpezaPodeProsseguir,
  planejarLimpeza,
  relatarOrfaos,
  type PlanoDeLimpeza,
} from '../../src/lib/e2e/limpezaSegura';
import { resolveStagingConfig } from '../../src/lib/e2e/stagingConfig';

interface Argumentos {
  readonly caminhoDoDiario: string;
  readonly simular: boolean;
}

function lerArgumentos(): Argumentos {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const caminhoDoDiario = args.find((a) => !a.startsWith('--'));
  if (!caminhoDoDiario) {
    throw new Error('Uso: npm run e2e:cleanup -- <caminho-do-diario.json> [--simular]');
  }
  return { caminhoDoDiario, simular: args.includes('--simular') };
}

/** Ref do projeto que a configuração autorizou, para conferir contra o diário. */
function refDoProjetoAutorizado(supabaseUrl: string): string {
  return new URL(supabaseUrl).hostname.toLowerCase().split('.')[0] ?? '';
}

/** Lê do projeto os registros que o diário diz ter criado. */
async function lerRegistrosDoProjeto(
  supabase: SupabaseClient,
  diario: DiarioDeExecucao,
): Promise<RegistroEncontrado[]> {
  const encontrados: RegistroEncontrado[] = [];

  const { data: organizacoes, error: erroOrganizacoes } = await supabase
    .from('organizacoes')
    .select('id, slug')
    .ilike('slug', `%${diario.plano.runId}%`);
  if (erroOrganizacoes) {
    throw new Error(`Falha ao ler organizações da execução: ${erroOrganizacoes.message}.`);
  }
  for (const linha of (organizacoes ?? []) as Array<{ id: string; slug: string }>) {
    encontrados.push({ identificador: linha.slug, id: linha.id });
  }

  // Usuários e memberships são lidos pelo id que o próprio diário registrou:
  // buscar por e-mail exigiria varrer a base de autenticação inteira, e é
  // justamente esse tipo de varredura que a conferência de identidade evita.
  for (const concluida of diario.concluidas) {
    const operacao = diario.plano.operacoes.find((o) => o.chave === concluida.chave);
    if (!operacao || operacao.tipo === 'organizacao') continue;

    if (operacao.tipo === 'usuario') {
      const { data, error } = await supabase.auth.admin.getUserById(concluida.idReal);
      if (error || !data?.user) continue;
      encontrados.push({ identificador: operacao.identificador, id: data.user.id });
      continue;
    }

    const { data, error } = await supabase
      .from('membros_organizacao')
      .select('id')
      .eq('id', concluida.idReal)
      .maybeSingle();
    if (error || !data) continue;
    encontrados.push({ identificador: operacao.identificador, id: String(data.id) });
  }

  return encontrados;
}

/** Executa apenas o que o plano aprovou, na ordem que ele definiu. */
async function executarLimpeza(supabase: SupabaseClient, plano: PlanoDeLimpeza): Promise<void> {
  for (const exclusao of plano.aprovadas) {
    if (exclusao.tipo === 'usuario') {
      const { error } = await supabase.auth.admin.deleteUser(exclusao.id);
      if (error) throw new Error(`Falha ao remover usuário ${exclusao.identificador}: ${error.message}.`);
      continue;
    }

    const tabela = exclusao.tipo === 'organizacao' ? 'organizacoes' : 'membros_organizacao';
    const { error } = await supabase.from(tabela).delete().eq('id', exclusao.id);
    if (error) throw new Error(`Falha ao remover ${exclusao.tipo} ${exclusao.identificador}: ${error.message}.`);
  }
}

async function limpar(): Promise<void> {
  const { caminhoDoDiario, simular } = lerArgumentos();

  const stagingConfig = resolveStagingConfig(process.env);
  if (!stagingConfig.supabaseUrl) {
    throw new Error('SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL é obrigatória para rodar o cleanup.');
  }
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY é obrigatória para rodar o cleanup (fail-closed, sem fallback).');
  }

  const projetoRef = refDoProjetoAutorizado(stagingConfig.supabaseUrl);
  const leitura = lerDiario(JSON.parse(readFileSync(caminhoDoDiario, 'utf8')), { projetoRef });
  if (leitura._tag !== 'DiarioValido') {
    throw new Error(
      `Diário recusado (${leitura.motivo._tag}). A limpeza não age sobre um diário que não confere com o `
        + `projeto autorizado (${projetoRef}).`,
    );
  }

  const supabase = createClient(stagingConfig.supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const encontrados = await lerRegistrosDoProjeto(supabase, leitura.diario);
  const plano = planejarLimpeza(leitura.diario, encontrados);

  process.stdout.write(`${descreverSimulacao(plano)}\n`);

  const orfaos = relatarOrfaos(encontrados, plano.runId, plano);
  if (orfaos.length > 0) {
    // Informativo por decisão: apagar por varredura é o que a conferência de
    // identidade existe para impedir. Quem decide é quem está operando.
    process.stdout.write(
      `\nÓRFÃOS desta execução (${orfaos.length}) — informativo, nada será apagado:\n`
        + orfaos.map((o) => `  ${o.identificador}  id=${o.id}`).join('\n')
        + '\n',
    );
  }

  if (!limpezaPodeProsseguir(plano)) {
    throw new Error(
      `${plano.recusadas.length} registro(s) recusado(s) na conferência de identidade. Nada foi apagado.`,
    );
  }

  if (simular) {
    process.stdout.write('\nSimulação: nada foi apagado.\n');
    return;
  }

  await executarLimpeza(supabase, plano);
  process.stdout.write(
    `\nLimpeza concluída: ${plano.aprovadas.length} removido(s), ${plano.jaRemovidas.length} já não existia(m).\n`,
  );
}

limpar().catch((error: unknown) => {
  process.stderr.write(`Falha na limpeza: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
