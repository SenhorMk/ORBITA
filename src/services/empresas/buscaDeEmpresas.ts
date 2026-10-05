import { TERMO_MAXIMO, TERMO_MINIMO, type EmpresaResumo } from '@/lib/empresas/empresaContract';

/**
 * Busca de empresa por nome (razão social ou nome fantasia).
 *
 * A BrasilAPI só consulta por CNPJ; não existe endpoint público de busca livre
 * por nome, e o ORBITA não faz scraping. A busca por nome depende de um
 * provedor comercial documentado, atrás desta porta, com a chave SÓ no
 * servidor (nunca `NEXT_PUBLIC_*`).
 *
 * Nenhum provedor está contratado: `provedorDeBuscaConfigurado` devolve `null`
 * e a rota responde `BuscaPorNomeIndisponivel` — o cadastro continua pelo
 * modo CNPJ e pelo preenchimento manual. Plugar um provedor é implementar esta
 * interface e devolvê-lo daqui quando a variável de ambiente existir.
 */
export interface EmpresaSearchProvider {
  /** Até `limite` empresas cujo nome corresponde ao termo. Lança em falha do provedor. */
  buscar(termo: string, limite: number): Promise<readonly EmpresaResumo[]>;
}

export function provedorDeBuscaConfigurado(): EmpresaSearchProvider | null {
  return null;
}

/** O termo como o provedor recebe: espaços colapsados; `null` fora dos limites. */
export function termoDeBusca(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const termo = valor.replace(/\s+/gu, ' ').trim();
  return termo.length >= TERMO_MINIMO && termo.length <= TERMO_MAXIMO ? termo : null;
}
