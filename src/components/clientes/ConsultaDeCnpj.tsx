'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { formatarCnpj } from '@/lib/documento';
import type { EmpresaCompleta } from '@/lib/empresas/empresaContract';

import { consultarCnpj, intencaoDaConsulta, type BuscaAutenticada } from './consultaDeEmpresa';
import { HelpInfo } from '@/components/help/HelpInfo';

/**
 * "Consultar CNPJ" no cadastro de contato. Só preenche: `onEmpresa` entrega a
 * consulta completa, e quem decide o que fazer com ela é o formulário. Falhar
 * aqui nunca impede o cadastro manual.
 *
 * Cada tecla cancela o temporizador e a requisição anteriores; a sequência
 * (`rodada`) descarta qualquer resposta que chegue depois de uma digitação
 * mais nova, e desmontar (fechar o modal) cancela a que estiver no ar.
 * `onEmpresa` é lido da última renderização (ref), então o preenchimento usa
 * o formulário como ele está quando a resposta chega, não como estava quando
 * a consulta começou.
 */

type Estado =
  | { readonly _tag: 'Ocioso' }
  | { readonly _tag: 'Consultando' }
  | { readonly _tag: 'Aviso'; readonly mensagem: string };

export const ATRASO_DA_CONSULTA_MS = 400;

const SEM_CONSULTA = 'Não foi possível consultar o CNPJ agora. Você ainda pode preencher o cadastro manualmente.';
const MUITAS_CONSULTAS = 'Muitas consultas em pouco tempo. Aguarde um instante e tente de novo.';
const SEM_PERMISSAO = 'Sua conta não pode cadastrar contatos nesta organização, por isso a consulta não está disponível.';
const NAO_ENCONTRADO = 'CNPJ não encontrado na Receita Federal.';
const CNPJ_INVALIDO = 'CNPJ inválido: confira os dígitos.';
const SO_CNPJ = 'A consulta é só por CNPJ: informe os 14 dígitos, com ou sem pontuação.';

export function ConsultaDeCnpj({
  buscar,
  onEmpresa,
  atrasoMs = ATRASO_DA_CONSULTA_MS,
}: {
  buscar: BuscaAutenticada;
  onEmpresa: (empresa: EmpresaCompleta) => void;
  atrasoMs?: number;
}) {
  const [texto, setTexto] = useState('');
  const [estado, setEstado] = useState<Estado>({ _tag: 'Ocioso' });
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controle = useRef<AbortController | null>(null);
  const rodada = useRef(0);
  const aoEncontrar = useRef(onEmpresa);

  useEffect(() => {
    aoEncontrar.current = onEmpresa;
  });

  useEffect(() => () => {
    rodada.current += 1;
    if (temporizador.current) clearTimeout(temporizador.current);
    controle.current?.abort();
  }, []);

  const cancelarAnterior = () => {
    if (temporizador.current) clearTimeout(temporizador.current);
    controle.current?.abort();
    rodada.current += 1;
    return rodada.current;
  };

  const consultar = async (cnpj: string, minha: number) => {
    const sinal = new AbortController();
    controle.current = sinal;
    try {
      const r = await consultarCnpj(cnpj, buscar, sinal.signal);
      if (minha !== rodada.current) return;
      switch (r.resultado) {
        case 'EmpresaEncontrada':
          setEstado({ _tag: 'Ocioso' });
          aoEncontrar.current(r.empresa);
          return;
        case 'EmpresaNaoEncontrada':
          setEstado({ _tag: 'Aviso', mensagem: NAO_ENCONTRADO });
          return;
        case 'CnpjInvalido':
          setEstado({ _tag: 'Aviso', mensagem: CNPJ_INVALIDO });
          return;
        case 'LimiteDeConsultas':
          setEstado({ _tag: 'Aviso', mensagem: MUITAS_CONSULTAS });
          return;
        case 'SemPermissao':
          setEstado({ _tag: 'Aviso', mensagem: SEM_PERMISSAO });
          return;
        case 'ConsultaIndisponivel':
          setEstado({ _tag: 'Aviso', mensagem: SEM_CONSULTA });
          return;
      }
    } catch {
      if (minha === rodada.current) setEstado({ _tag: 'Aviso', mensagem: SEM_CONSULTA });
    }
  };

  const aoDigitar = (valor: string) => {
    setTexto(valor);
    const minha = cancelarAnterior();
    const intencao = intencaoDaConsulta(valor);
    switch (intencao._tag) {
      case 'Vazio':
      case 'Incompleto':
        setEstado({ _tag: 'Ocioso' });
        return;
      case 'CnpjInvalido':
        setEstado({ _tag: 'Aviso', mensagem: CNPJ_INVALIDO });
        return;
      case 'NaoCnpj':
        setEstado({ _tag: 'Aviso', mensagem: SO_CNPJ });
        return;
      case 'Cnpj':
        setEstado({ _tag: 'Consultando' });
        temporizador.current = setTimeout(() => { void consultar(intencao.cnpj, minha); }, atrasoMs);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <HelpInfo ajudaId="clientes.cnpj" />
      <label htmlFor="cliente-consulta-cnpj" className="orbita-eyebrow">Consultar CNPJ</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--txt3)' }} aria-hidden />
        <input
          id="cliente-consulta-cnpj"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={texto}
          maxLength={18}
          onChange={(e) => aoDigitar(e.target.value)}
          className="orbita-campo orbita-campo--mono"
          style={{ paddingLeft: 34 }}
          placeholder="00.000.000/0000-00"
          aria-describedby="cliente-consulta-cnpj-ajuda"
        />
        {estado._tag === 'Consultando' && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin" style={{ color: 'var(--txt2)' }} aria-hidden />
        )}
      </div>
      <span id="cliente-consulta-cnpj-ajuda" className="text-[11px]" style={{ color: 'var(--txt3)' }}>
        Preenche os dados cadastrais da empresa. Nada é salvo até você clicar em &quot;Salvar contato&quot;.
      </span>

      <output aria-live="polite" className="text-[11px]" style={{ color: estado._tag === 'Aviso' ? 'var(--warning)' : 'var(--txt2)' }}>
        {estado._tag === 'Consultando' && 'Consultando o CNPJ…'}
        {estado._tag === 'Aviso' && estado.mensagem}
      </output>
    </div>
  );
}

/**
 * Depois de preencher: conferir antes de salvar. Diz qual empresa foi
 * consultada, o que ficou como a pessoa tinha digitado, o documento que foi
 * substituído e, se o CPF/CNPJ do formulário deixou de ser o da empresa, que
 * o cadastro está contraditório.
 */
export function AvisoDePreenchimento({
  empresa,
  mantidos,
  documentoSubstituido,
  documentoDivergente,
  onUsarNomeFantasia,
  onDescartar,
}: {
  empresa: EmpresaCompleta;
  mantidos: readonly string[];
  documentoSubstituido: string | null;
  documentoDivergente: boolean;
  onUsarNomeFantasia: () => void;
  onDescartar: () => void;
}) {
  return (
    <output
      className="flex flex-col gap-1.5 px-4 py-2.5 text-xs"
      style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
    >
      <span className="font-semibold" style={{ color: 'var(--accent)' }}>Dados encontrados. Confira antes de salvar.</span>
      <span>Empresa consultada: {empresa.razaoSocial} (CNPJ {formatarCnpj(empresa.cnpj)}).</span>
      {documentoSubstituido && (
        <span style={{ color: 'var(--warning)' }}>
          O documento que você tinha informado ({documentoSubstituido}) foi substituído pelo CNPJ consultado.
        </span>
      )}
      {mantidos.length > 0 && <span>Mantidos os campos que você já tinha preenchido: {mantidos.join(', ')}.</span>}
      {documentoDivergente && (
        <span role="alert" style={{ color: 'var(--danger)' }}>
          O CPF/CNPJ do formulário não é mais o da empresa consultada. Corrija o documento ou descarte a consulta antes de salvar.
        </span>
      )}
      <span>Confira o tipo de contribuinte: o CNPJ não indica se a empresa é contribuinte de ICMS.</span>
      <span className="flex flex-wrap items-center gap-2">
        {empresa.nomeFantasia && (
          <>
            Nome fantasia: <strong style={{ color: 'var(--txt)' }}>{empresa.nomeFantasia}</strong>
            <button type="button" onClick={onUsarNomeFantasia} className="orbita-chip cursor-pointer">
              Usar nome fantasia como nome
            </button>
          </>
        )}
        <button type="button" onClick={onDescartar} className="orbita-chip cursor-pointer">
          Descartar consulta
        </button>
      </span>
    </output>
  );
}
