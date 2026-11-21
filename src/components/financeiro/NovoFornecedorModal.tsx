'use client';

import React from 'react';
import { Building2, CheckCircle, Loader2, XCircle } from 'lucide-react';

import { Modal, RodapeDeModal } from '@/components/ui/modal';
import { HelpInfo } from '@/components/help/HelpInfo';

export interface DadosCNPJ {
  razao_social: string;
  nome_fantasia: string;
  logradouro: string;
  numero: string;
  bairro: string;
  municipio: string;
  uf: string;
  cep: string;
  ddd_telefone_1?: string;
  email?: string;
  descricao_situacao_cadastral?: string;
}

interface NovoFornecedorModalProps {
  isOpen: boolean;
  onVoltar: () => void;
  cnpj: string;
  onCNPJChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  dadosCNPJ: DadosCNPJ | null;
  buscandoCNPJ: boolean;
  erroCNPJ: string;
  salvandoFornecedor: boolean;
  onSalvar: () => void;
}

const ROTULO = 'text-xs font-semibold uppercase tracking-wider mb-1.5 block';
const COR_DO_ROTULO = { color: 'var(--txt2)' } as const;

/** Campo preenchido pela Receita e bloqueado: o valor é do provedor, não do usuário. */
function CampoBloqueado({
  id,
  rotulo,
  valor,
  placeholder = 'Preenchido automaticamente',
}: {
  id: string;
  rotulo: string;
  valor: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label htmlFor={id} className={ROTULO} style={COR_DO_ROTULO}>{rotulo}</label>
      <input
        id={id}
        readOnly
        value={valor}
        placeholder={placeholder}
        className="orbita-campo cursor-not-allowed select-none"
        style={{ background: 'var(--chip)', color: 'var(--txt2)' }}
      />
    </div>
  );
}

/**
 * "Cadastrar Fornecedor", no `Modal` do Design System.
 *
 * A consulta ao CNPJ pela BrasilAPI, os estados de busca, o erro, os campos
 * bloqueados depois de encontrado e a gravação pelo endpoint de fornecedores
 * são os mesmos — só a casca mudou.
 *
 * A costura com "Nova Despesa" é o que este diálogo não pode quebrar: sair
 * daqui por qualquer caminho (Voltar, o X do cabeçalho ou salvar) devolve para
 * a despesa, e o fornecedor recém-criado volta já selecionado. Por isso o
 * fechar do cabeçalho aponta para `onVoltar`, e não para um fechar genérico.
 */
export function NovoFornecedorModal({
  isOpen, onVoltar, cnpj, onCNPJChange, dadosCNPJ, buscandoCNPJ, erroCNPJ, salvandoFornecedor, onSalvar,
}: NovoFornecedorModalProps) {
  return (
    <Modal
      aberto={isOpen}
      onAbertoChange={(aberto) => { if (!aberto) onVoltar(); }}
      tamanho="md"
      dispensavel={false}
      eyebrow="Nova despesa · fornecedor"
      titulo="Cadastrar Fornecedor"
      descricao="Preencha o CNPJ e deixamos a mágica rolar"
      descricaoOculta={false}
      rodape={
        <RodapeDeModal
          secundaria={
            <button type="button" onClick={onVoltar} className="orbita-chip cursor-pointer">
              Voltar
            </button>
          }
          primaria={
            <button
              type="button"
              onClick={onSalvar}
              disabled={!dadosCNPJ || salvandoFornecedor}
              className="orbita-chip cursor-pointer"
              style={{ background: 'var(--accent)', borderColor: 'var(--accent)', color: 'var(--accent-fg)' }}
            >
              {salvandoFornecedor
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando no Bling...</>
                : <><Building2 className="w-4 h-4" /> Salvar Fornecedor</>}
            </button>
          }
        />
      }
     ajuda={<HelpInfo ajudaId="financeiro.fornecedor" />}>

      <div className="space-y-4">
        <div>
          <label htmlFor="fornecedor-cnpj" className={ROTULO} style={COR_DO_ROTULO}>CNPJ</label>
          <div className="relative">
            <input
              id="fornecedor-cnpj"
              type="text"
              value={cnpj}
              onChange={onCNPJChange}
              maxLength={18}
              placeholder="00.000.000/0000-00"
              aria-invalid={erroCNPJ ? true : undefined}
              className="orbita-campo orbita-campo--mono pr-10"
            />
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              {buscandoCNPJ && <Loader2 className="w-4 h-4 animate-spin" style={{ color: 'var(--txt2)' }} />}
              {!buscandoCNPJ && dadosCNPJ && <CheckCircle className="w-4 h-4" style={{ color: 'var(--accent)' }} />}
              {!buscandoCNPJ && erroCNPJ && <XCircle className="w-4 h-4" style={{ color: 'var(--danger)' }} />}
            </div>
          </div>
          {erroCNPJ && (
            <p className="text-xs mt-1.5 m-0" role="alert" style={{ color: 'var(--danger)' }}>{erroCNPJ}</p>
          )}
        </div>

        <CampoBloqueado id="fornecedor-razao-social" rotulo="Razão Social" valor={dadosCNPJ?.razao_social || ''} />
        <CampoBloqueado id="fornecedor-nome-fantasia" rotulo="Nome Fantasia" valor={dadosCNPJ?.nome_fantasia || ''} />

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <CampoBloqueado
              id="fornecedor-logradouro"
              rotulo="Logradouro"
              valor={dadosCNPJ ? `${dadosCNPJ.logradouro}, ${dadosCNPJ.numero}` : ''}
              placeholder="Rua, Número"
            />
          </div>
          <CampoBloqueado id="fornecedor-uf" rotulo="UF" valor={dadosCNPJ?.uf || ''} placeholder="UF" />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <CampoBloqueado id="fornecedor-municipio" rotulo="Município" valor={dadosCNPJ?.municipio || ''} />
          <CampoBloqueado id="fornecedor-cep" rotulo="CEP" valor={dadosCNPJ?.cep || ''} />
        </div>

        {dadosCNPJ && (
          <p
            className="flex items-center gap-2 px-4 py-2.5 text-xs m-0"
            style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
          >
            <CheckCircle className="w-4 h-4 shrink-0" style={{ color: 'var(--accent)' }} />
            <span>Dados verificados pela Receita Federal • Campos bloqueados para garantir integridade</span>
          </p>
        )}
      </div>
    </Modal>
  );
}
