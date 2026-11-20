/**
 * `pedidos.data` é uma DATA de negócio (o dia da venda), sem hora: o Bling manda `AAAA-MM-DD` e o banco
 * guarda meia-noite UTC. Ler isso como instante no fuso do navegador desloca o dia em Brasília para
 * "dia anterior, 21:00" e inventa uma hora que não existe. Aqui a data é lida pelas partes UTC.
 */

const DIA_EM_SAO_PAULO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MS_POR_DIA = 86_400_000;

/** O dia de negócio da data guardada, como milissegundos da meia-noite UTC, ou `null` se ilegível. */
function diaGuardado(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const quando = new Date(iso);
  if (!Number.isFinite(quando.getTime())) return null;
  return Date.UTC(quando.getUTCFullYear(), quando.getUTCMonth(), quando.getUTCDate());
}

/** `dd/mm`, ou `dd/mm/aaaa` com `comAno`. `—` quando a data não dá para ler. */
export function formatarDataDoPedido(iso: string | null | undefined, comAno = false): string {
  const dia = diaGuardado(iso);
  if (dia === null) return '—';
  const d = new Date(dia);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return comAno ? `${dd}/${mm}/${d.getUTCFullYear()}` : `${dd}/${mm}`;
}

/** Idade em dias em relação a hoje em Brasília: "hoje", "ontem", "há N dias". `null` se ilegível. */
export function idadeDaDataDoPedido(iso: string | null | undefined, agora: number = Date.now()): string | null {
  const dia = diaGuardado(iso);
  if (dia === null) return null;
  const hoje = Date.parse(`${DIA_EM_SAO_PAULO.format(new Date(agora))}T00:00:00Z`);
  const dias = Math.round((hoje - dia) / MS_POR_DIA);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  return `há ${dias} dias`;
}

/** O dia de negócio de um instante em Brasília, `AAAA-MM-DD`: a data com que uma venda feita agora é gravada. */
export function diaEmSaoPaulo(instante: Date): string {
  return DIA_EM_SAO_PAULO.format(instante);
}
