import type { ProdutoFormato, ProdutoSituacao, ProdutoTipo } from '@/lib/config/produtoContract';

/**
 * Os obrigatórios do Bling de um produto que já existe lá.
 *
 * `tipo`, `situacao` e `formato` são exigidos pelo `PUT` do provedor e **não**
 * são persistidos no registro local. Sem lê-los, o formulário só teria o padrão
 * — e salvar com padrão sobrescreve no ERP o que estava: serviço viraria
 * produto, inativo voltaria a ativo, composição viraria simples.
 *
 * A leitura acontece no servidor (`GET /api/produtos/bling/[blingId]`), que
 * exige a mesma capacidade de quem grava o catálogo. O token do ERP nunca
 * chega ao navegador.
 */
export interface ObrigatoriosDoBling {
  readonly tipo: ProdutoTipo;
  readonly situacao: ProdutoSituacao;
  readonly formato: ProdutoFormato;
  readonly unidade: string;
}

type BuscaAutenticada = (url: string, options?: RequestInit) => Promise<Response>;

/**
 * Lê os obrigatórios, ou devolve `null`.
 *
 * `null` é "não se sabe", e quem chama precisa tratá-lo como bloqueio — nunca
 * como permissão para usar o padrão. Falha de rede, recusa do provedor e
 * resposta fora do contrato são o mesmo desfecho aqui: sem valor autoritativo.
 */
export async function lerObrigatoriosDoBling(
  fetchWithAuth: BuscaAutenticada,
  blingId: string,
): Promise<ObrigatoriosDoBling | null> {
  try {
    const res = await fetchWithAuth(`/api/produtos/bling/${encodeURIComponent(blingId)}`);
    if (!res.ok) return null;
    const corpo = (await res.json()) as { success?: boolean; obrigatorios?: ObrigatoriosDoBling };
    if (corpo.success !== true || !corpo.obrigatorios) return null;

    const { tipo, situacao, formato, unidade } = corpo.obrigatorios;
    if (!tipo || !situacao || !formato || !unidade?.trim()) return null;

    return { tipo, situacao, formato, unidade: unidade.trim() };
  } catch {
    return null;
  }
}
