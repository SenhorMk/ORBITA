/** Data de hoje em `America/Sao_Paulo`, no formato `AAAA-MM-DD`. */
export function hojeEmSaoPaulo(): string {
  // `Intl` com `en-CA` já devolve AAAA-MM-DD. A versão anterior fazia
  // `toLocaleString('en-US', {timeZone})` → `new Date(...)` → `toISOString()`,
  // que reinterpreta a hora local como UTC e erra o dia perto da meia-noite.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
