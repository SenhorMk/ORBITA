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
 * Mapeia a situação/status do Bling para os valores canônicos
 * Valores aceitos: 'Novo' | 'Aberto' | 'Em Processamento' | 'Despachado' | 'Enviado' | 'Entregue' | 'Pendente' | 'A Emitir' | 'Atendido' | 'Cancelado'
 */
export function mapBlingStatus(status?: string): string {
  if (!status) return 'Novo';

  const normalized = status.trim().toLowerCase();

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
  return name.replace(/[^a-zA-ZÀ-ÿçÇ0-9\s\-/\.,\()\&'\"]/g, '').trim();
}

import { BlingProductSchema } from '../schemas/bling';

/**
 * Valida se um produto possui todos os dados obrigatórios para ser sincronizado com o Bling v3.
 * Usa o Zod Schema para garantir consistência.
 * Retorna { valid: true } ou { valid: false, errors: [...] }
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

  // Adaptamos o input para o Zod Schema
  const parseResult = BlingProductSchema.safeParse({
    nome: produto.nome || '',
    preco: precoNum || 0,
    codigo: produto.codigo,
    tipo: produto.tipo,
    situacao: produto.situacao,
    formato: produto.formato,
    unidade: produto.unidade,
  });

  const errors: string[] = [];

  // Validar nome com caracteres especiais permitidos
  if (produto.nome) {
    const sanitized = sanitizeProductName(produto.nome);
    if (sanitized !== produto.nome.trim()) {
      errors.push(`O nome contém caracteres especiais não aceitos pelo Bling. Sugestão: "${sanitized}"`);
    }
  }

  // Estoque (validação que ficou de fora do Zod base pq Zod foca no Bling)
  const estoqueRaw = typeof produto.estoque === 'string' ? produto.estoque : String(produto.estoque ?? '');
  if (estoqueRaw.trim() === '') {
    errors.push('O campo de estoque é obrigatório.');
  } else {
    const estoqueNum = Number(estoqueRaw);
    if (isNaN(estoqueNum) || !Number.isInteger(estoqueNum)) {
      errors.push(`O estoque deve ser um número inteiro (sem decimais). Valor informado: ${estoqueRaw}`);
    } else if (estoqueNum < 0) {
      errors.push('O estoque não pode ser negativo.');
    }
  }

  if (!parseResult.success) {
    parseResult.error.issues.forEach(err => {
      errors.push(err.message);
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Verifica se um produto está sincronizado com o Bling (bling_id numérico real).
 */
export function isProdutoSynced(blingId?: string): boolean {
  if (!blingId) return false;
  return /^\d+$/.test(blingId.trim());
}
