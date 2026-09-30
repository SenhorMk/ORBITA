export type MotivoDeReconciliacaoDeProduto =
  | 'duplicado_com_foto'
  | 'foto_confirmada_durante_deduplicacao'
  | 'estado_inesperado_na_deduplicacao';

/**
 * A gravação local foi interrompida para não trocar a identidade do produto
 * nem descartar uma foto do ORBITA. A mensagem é pública: não carrega SQL nem
 * erro do banco, e a rota de produto a coloca depois de "Produto salvo no
 * Bling, mas falhou ao gravar no ORBITA".
 */
export class ReconciliacaoDeProdutoNecessaria extends Error {
  constructor(readonly motivo: MotivoDeReconciliacaoDeProduto) {
    super(
      'outro produto do ORBITA já usa este cadastro do Bling e tem foto personalizada '
      + '(ou mudou durante a gravação); os dois foram preservados e precisam ser reconciliados',
    );
  }
}
