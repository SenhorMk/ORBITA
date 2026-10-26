import { randomUUID } from 'node:crypto';
import type {
  CandidatoDeIdentidade,
  EscopoDaConexaoChatwoot,
  EspelhoChatwootStore,
  RecursoChatwoot,
  ResultadoDoStore,
} from '@/services/chatwoot/identidadeChatwoot';

/**
 * Espelhos do Chatwoot em memória com as regras do banco que importam para a
 * identidade (migration 85): identidade remota única por organização +
 * conexão, FK composta para o pai pelo UUID local na mesma conexão, conexão
 * imutável depois de provada e, até o MSG-004, a PK global `id`.
 *
 * Os desvios (`semFiltroDeConexao`, `buscaGlobal`) existem para as
 * contraprovas: um store que não filtra precisa ser pego pelo resolver.
 */

export type LinhaDoEspelho = Record<string, unknown> & {
  id_local: string;
  id: number;
  id_externo: string;
  organizacao_id: string;
  conexao_id: string | null;
};

export interface OpcoesDoFake {
  /** `true` (padrão) = antes do MSG-004: `id` é PK global. */
  readonly pkGlobal?: boolean;
  /** Sabotagem: a busca por id remoto ignora a conexão. */
  readonly semFiltroDeConexao?: boolean;
  /** Sabotagem: a busca por id remoto ignora organização e conexão. */
  readonly buscaGlobal?: boolean;
}

const PAI: Partial<Record<RecursoChatwoot, { recurso: RecursoChatwoot; local: string; legado: string }>> = {
  conversa: { recurso: 'contato', local: 'contato_id_local', legado: 'contact_id' },
  mensagem: { recurso: 'conversa', local: 'conversa_id_local', legado: 'conversation_id' },
};

const ok = <T>(valor: T): ResultadoDoStore<T> => ({ _tag: 'StoreOk', valor });
const falha = <T>(codigo: string): ResultadoDoStore<T> => ({ _tag: 'StoreFalhou', codigo });

export class EspelhoChatwootFake implements EspelhoChatwootStore {
  readonly linhas: Record<RecursoChatwoot, LinhaDoEspelho[]> = { contato: [], conversa: [], mensagem: [] };
  readonly chamadas: Array<{ operacao: string; recurso: RecursoChatwoot }> = [];
  /** Executado antes de cada inserção: simula uma escrita concorrente. */
  antesDeInserir: ((recurso: RecursoChatwoot) => void) | null = null;
  /** Código a devolver na próxima operação (falha do banco). */
  falharProxima: string | null = null;

  constructor(private readonly opcoes: OpcoesDoFake = {}) {}

  /** Linha gravada direto, como o legado ou outra instalação. */
  semear(
    recurso: RecursoChatwoot,
    linha: Record<string, unknown> & { id: number; organizacao_id: string; conexao_id: string | null; id_local?: string },
  ): string {
    const idLocal = linha.id_local ?? randomUUID();
    this.linhas[recurso].push({ ...linha, id_local: idLocal, id_externo: String(linha.id) });
    return idLocal;
  }

  porIdLocal(recurso: RecursoChatwoot, idLocal: string): LinhaDoEspelho | undefined {
    return this.linhas[recurso].find((l) => l.id_local === idLocal);
  }

  private falhaInjetada(): string | null {
    const codigo = this.falharProxima;
    this.falharProxima = null;
    return codigo;
  }

  async buscarPorIdExterno(recurso: RecursoChatwoot, escopo: EscopoDaConexaoChatwoot, idExterno: string) {
    this.chamadas.push({ operacao: 'buscarPorIdExterno', recurso });
    const injetada = this.falhaInjetada();
    if (injetada) return falha<readonly CandidatoDeIdentidade[]>(injetada);
    const candidatos = this.linhas[recurso]
      .filter((l) => l.id_externo === idExterno)
      .filter((l) => this.opcoes.buscaGlobal || l.organizacao_id === escopo.organizacaoId)
      .filter((l) => this.opcoes.buscaGlobal || this.opcoes.semFiltroDeConexao
        || l.conexao_id === escopo.conexaoId || l.conexao_id === null)
      .map((l) => ({ idLocal: l.id_local, conexaoId: l.conexao_id }));
    return ok<readonly CandidatoDeIdentidade[]>(candidatos);
  }

  async buscarConexaoPorIdLocal(recurso: RecursoChatwoot, organizacaoId: string, idLocal: string) {
    this.chamadas.push({ operacao: 'buscarConexaoPorIdLocal', recurso });
    const injetada = this.falhaInjetada();
    if (injetada) return falha<{ readonly conexaoId: string | null } | null>(injetada);
    const linha = this.linhas[recurso].find((l) => l.id_local === idLocal && l.organizacao_id === organizacaoId);
    return ok<{ readonly conexaoId: string | null } | null>(linha ? { conexaoId: linha.conexao_id } : null);
  }

  async buscarPorIdLocal(recurso: RecursoChatwoot, escopo: EscopoDaConexaoChatwoot, idLocal: string) {
    this.chamadas.push({ operacao: 'buscarPorIdLocal', recurso });
    const injetada = this.falhaInjetada();
    if (injetada) return falha<string | null>(injetada);
    const linha = this.linhas[recurso].find((l) => l.id_local === idLocal
      && l.organizacao_id === escopo.organizacaoId && l.conexao_id === escopo.conexaoId);
    return ok<string | null>(linha ? linha.id_externo : null);
  }

  private vinculoValido(recurso: RecursoChatwoot, linha: LinhaDoEspelho): boolean {
    const pai = PAI[recurso];
    if (!pai) return true;
    const alvo = this.linhas[pai.recurso].find((p) => p.id_local === linha[pai.local]
      && p.organizacao_id === linha.organizacao_id);
    if (!alvo || alvo.id !== linha[pai.legado]) return false;
    return alvo.conexao_id === null || linha.conexao_id === null || alvo.conexao_id === linha.conexao_id;
  }

  async inserir(recurso: RecursoChatwoot, dados: Readonly<Record<string, unknown>>) {
    this.chamadas.push({ operacao: 'inserir', recurso });
    this.antesDeInserir?.(recurso);
    const injetada = this.falhaInjetada();
    if (injetada) return falha<string>(injetada);
    const linha = { id_local: randomUUID(), ...dados } as LinhaDoEspelho;
    linha.id_externo = String(linha.id);
    const tabela = this.linhas[recurso];
    if (this.opcoes.pkGlobal !== false && tabela.some((l) => l.id === linha.id)) return falha<string>('23505');
    if (tabela.some((l) => l.organizacao_id === linha.organizacao_id && l.conexao_id === linha.conexao_id
      && l.id_externo === linha.id_externo)) return falha<string>('23505');
    if (!this.vinculoValido(recurso, linha)) return falha<string>('23503');
    tabela.push(linha);
    return ok(linha.id_local);
  }

  async atualizar(
    recurso: RecursoChatwoot,
    escopo: EscopoDaConexaoChatwoot,
    idLocal: string,
    campos: Readonly<Record<string, unknown>>,
    opcoes?: { readonly somenteConexaoProvada?: boolean },
  ) {
    this.chamadas.push({ operacao: 'atualizar', recurso });
    const injetada = this.falhaInjetada();
    if (injetada) return falha<number>(injetada);
    const tabela = this.linhas[recurso];
    const indice = tabela.findIndex((l) => l.id_local === idLocal && l.organizacao_id === escopo.organizacaoId
      && (l.conexao_id === escopo.conexaoId || (l.conexao_id === null && !opcoes?.somenteConexaoProvada)));
    if (indice < 0) return ok(0);
    const atual = tabela[indice]!;
    const nova = { ...atual, ...campos } as LinhaDoEspelho;
    if (atual.conexao_id !== null && nova.conexao_id !== atual.conexao_id) return falha<number>('23514');
    if (!this.vinculoValido(recurso, nova)) return falha<number>('23503');
    tabela[indice] = nova;
    return ok(1);
  }
}
