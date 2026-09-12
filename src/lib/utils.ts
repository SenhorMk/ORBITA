import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Normaliza um número de telefone para o formato E.164 (+55...)
 */
export function normalizeToE164(phone?: string): string | null {
  if (!phone) return null;

  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) return null;

  if (hasPlus) {
    return `+${digits}`;
  }

  // Se for número nacional do Brasil sem DDI (ex: 11987654321 ou 1187654321)
  if (digits.length === 10 || digits.length === 11) {
    return `+55${digits}`;
  }

  // Se já tiver DDI do Brasil (55) com 12 ou 13 dígitos
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return `+${digits}`;
  }

  return `+${digits}`;
}

/**
 * Situações da venda por código numérico, como o Bling as publica no OpenAPI
 * oficial (`ContasReceberDadosOrigemDTO.situacao`, "Situações da venda").
 *
 * `VendasSituacaoDTO.valor` é `integer`, não texto — e era exatamente esse o
 * defeito: `mapBlingStatus(bp.situacao.valor)` recebia um número e estourava
 * com `e.trim is not a function`, derrubando a etapa de pedidos inteira. Pior:
 * mesmo se o número chegasse como string, nenhum caso do `switch` por nome
 * casaria e todo pedido viraria 'Novo' em silêncio.
 *
 * Três destinos são juízo nosso, não do Bling, porque o vocabulário canônico
 * do ORBITA é mais grosso que o do Bling: 5 e 6 (parciais) viram
 * 'Em Processamento', e 8/11 viram 'A Emitir' por serem os estados em que o
 * passo seguinte é a nota fiscal.
 */
const SITUACOES_VENDA_BLING: Readonly<Record<number, string>> = Object.freeze({
  0: 'Pendente', // Em aberto — mesmo destino que o texto 'em aberto' já tinha
  1: 'Atendido',
  2: 'Cancelado',
  3: 'Em Processamento', // Em andamento
  5: 'Em Processamento', // Faturado parcialmente
  6: 'Em Processamento', // Atendido parcialmente
  7: 'Pendente', // Aguardando pagamento
  8: 'A Emitir', // Pagamento confirmado
  10: 'Novo', // Em digitação
  11: 'A Emitir', // Verificado
  12: 'Em Processamento', // Checkout parcial
});

/**
 * Mapeia a situação/status do Bling para os valores canônicos
 * Valores aceitos: 'Novo' | 'Aberto' | 'Em Processamento' | 'Despachado' | 'Enviado' | 'Entregue' | 'Pendente' | 'A Emitir' | 'Atendido' | 'Cancelado'
 *
 * Aceita número (pedidos de venda, onde `situacao.valor` é `integer`) e texto
 * (webhook e financeiro, que enviam o rótulo).
 */
export function mapBlingStatus(status?: string | number | null): string {
  if (status === null || status === undefined || status === '') return 'Novo';

  if (typeof status === 'number') {
    return SITUACOES_VENDA_BLING[status] ?? 'Novo';
  }

  const normalized = status.trim().toLowerCase();

  // Um número que chegou como texto é o mesmo código, não um rótulo.
  if (/^\d+$/u.test(normalized)) {
    return SITUACOES_VENDA_BLING[Number(normalized)] ?? 'Novo';
  }

  switch (normalized) {
    case 'novo':
      return 'Novo';
    case 'pendente':
    case 'em aberto':
      return 'Pendente';
    case 'a emitir':
    case 'a faturar':
      return 'A Emitir';
    case 'atendido':
    case 'pago':
    case 'faturado':
      return 'Atendido';
    case 'cancelado':
    case 'devolvido':
      return 'Cancelado';
    case 'aberto':
      return 'Aberto';
    case 'em processamento':
    case 'em andamento':
      return 'Em Processamento';
    case 'despachado':
      return 'Despachado';
    case 'enviado':
      return 'Enviado';
    case 'entregue':
      return 'Entregue';
    default:
      return 'Novo';
  }
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ═══════════════════════════════════════════════════════════════════════
// Validação de Produto para Bling API v3
// Campos obrigatórios: nome, tipo, situacao, formato, preco, unidade
// ═══════════════════════════════════════════════════════════════════════

export interface ProdutoValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Remove caracteres especiais que o Bling não aceita no nome do produto.
 * Permite: letras (com acentos), números, espaços, hífens, barras, pontos, e comercial, aspas.
 */
export function sanitizeProductName(name: string): string {
  // Remove caracteres não permitidos, mantém letras acentuadas, números, espaços, hífens, barras, pontos, &, ç, aspas
  return name.replace(/[^a-zA-ZÀ-ÿçÇ0-9\s\-/.,()&'"]/g, '').trim();
}

import { produtoRequestSchema } from './config/produtoContract';

/**
 * Valida o FORMULÁRIO de produto contra o contrato compartilhado.
 *
 * A validação deriva de `produtoRequestSchema`, o mesmo schema que
 * `buildProdutoRequest` monta e que a rota executa. Antes ela derivava de um
 * segundo enum, mantido à parte, que aceitava `tipo` P|S e `formato` S|V —
 * enquanto o contrato oficial (transcrito do OpenAPI do Bling) aceita `tipo`
 * S|P|N e `formato` S|V|E. O formulário oferecia "Composição" (`E`) e o
 * validador local recusava o próprio valor que a tela acabara de oferecer.
 *
 * Um enum só, num lugar só: é o que impede a tela e o validador de
 * discordarem.
 *
 * Só serve a quem tem os campos obrigatórios do Bling em mãos — o formulário.
 * O registro local (`Produto`) não guarda `tipo`, `situacao` nem `formato`, e
 * chamar isto sobre ele produzia ausências inventadas.
 */
export function validateProdutoForBling(produto: {
  nome?: string;
  preco?: number | string;
  estoque?: number | string;
  codigo?: string;
  tipo?: string;
  situacao?: string;
  formato?: string;
  unidade?: string;
}): ProdutoValidationResult {
  const precoNum = typeof produto.preco === 'string' ? parseFloat(produto.preco) : produto.preco;
  const errors: string[] = [];

  const estoqueRaw = typeof produto.estoque === 'string' ? produto.estoque : String(produto.estoque ?? '');
  const estoqueNum = estoqueRaw.trim() === '' ? undefined : Number(estoqueRaw);

  const parseResult = produtoRequestSchema.safeParse({
    nome: produto.nome ?? '',
    preco: Number.isFinite(precoNum) ? precoNum : 0,
    // `estoque` é opcional no contrato — o saldo entra por outra rota —, mas o
    // formulário o coleta, e um valor fracionário ou negativo tem de ser
    // recusado aqui e não pelo provedor.
    estoque: estoqueNum,
    // O contrato recusa string vazia em `codigo`; o campo é opcional, e vazio
    // significa "não informado", não "informado como nada".
    codigo: produto.codigo?.trim() ? produto.codigo.trim() : undefined,
    tipo: produto.tipo,
    situacao: produto.situacao,
    formato: produto.formato,
    unidade: produto.unidade,
  });

  if (!parseResult.success) {
    parseResult.error.issues.forEach((issue) => {
      errors.push(issue.message);
    });
  }

  // O contrato cobre obrigatoriedade, faixa e enums. O que ele não expressa é a
  // sanitização do nome, que é regra do provedor sobre caracteres aceitos.
  errors.push(...pendenciaDeNome(produto.nome));

  return {
    valid: errors.length === 0,
    errors,
  };
}

/** O nome tem caractere que o Bling recusa? */
function pendenciaDeNome(nome: string | undefined): string[] {
  if (!nome || nome.trim() === '') return [];
  const sanitized = sanitizeProductName(nome);
  return sanitized === nome.trim()
    ? []
    : [`O nome contém caracteres especiais não aceitos pelo Bling. Sugestão: "${sanitized}"`];
}

/**
 * O que falta no registro LOCAL — e só o que existe nele.
 *
 * Esta é a lista que a tabela de estoque pode chamar de "faltando": campos que
 * o contrato local (`Produto`) de fato guarda e que a pessoa consegue corrigir
 * naquele registro. `tipo`, `situacao` e `formato` ficam de fora porque o banco
 * não os persiste: exigi-los ali era relatar ausência de um dado que nunca
 * existiu na linha.
 */
export function pendenciasLocaisDoProduto(produto: {
  nome?: string;
  preco?: number | string;
  estoque?: number | string;
}): string[] {
  const errors: string[] = [];

  if (!produto.nome || produto.nome.trim() === '') {
    errors.push('O nome do produto é obrigatório.');
  } else {
    errors.push(...pendenciaDeNome(produto.nome));
  }

  const precoRaw = typeof produto.preco === 'string' ? produto.preco : String(produto.preco ?? '');
  if (precoRaw.trim() === '') {
    errors.push('O preço é obrigatório.');
  } else {
    const precoNum = Number(precoRaw);
    if (Number.isNaN(precoNum)) errors.push(`O preço deve ser um número. Valor informado: ${precoRaw}`);
    else if (precoNum < 0) errors.push('O preço não pode ser negativo.');
  }

  const estoqueRaw = typeof produto.estoque === 'string' ? produto.estoque : String(produto.estoque ?? '');
  if (estoqueRaw.trim() === '') {
    errors.push('O campo de estoque é obrigatório.');
  } else {
    const estoqueNum = Number(estoqueRaw);
    if (Number.isNaN(estoqueNum) || !Number.isInteger(estoqueNum)) {
      errors.push(`O estoque deve ser um número inteiro (sem decimais). Valor informado: ${estoqueRaw}`);
    } else if (estoqueNum < 0) {
      errors.push('O estoque não pode ser negativo.');
    }
  }

  return errors;
}

/**
 * Verifica se um produto está sincronizado com o Bling (bling_id numérico real).
 */
export function isProdutoSynced(blingId?: string): boolean {
  if (!blingId) return false;
  return /^\d+$/.test(blingId.trim());
}
