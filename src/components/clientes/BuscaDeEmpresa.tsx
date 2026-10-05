'use client';

import { useEffect, useRef, useState } from 'react';
import { Building2, Loader2, Search } from 'lucide-react';

import { formatarCnpj } from '@/lib/empresas/cnpj';
import type { EmpresaCompleta, EmpresaResumo } from '@/lib/empresas/empresaContract';

import { buscarEmpresas, consultarCnpj, intencaoDaBusca, type BuscaAutenticada } from './consultaDeEmpresa';

/**
 * "Buscar empresa" no cadastro de contato: por nome, razão social, nome
 * fantasia ou CNPJ. Só sugere — `onEmpresa` entrega a consulta COMPLETA por
 * CNPJ, e quem decide o que fazer com ela é o formulário. Falhar aqui nunca
 * impede o cadastro manual.
 *
 * Debounce sem efeito: cada tecla cancela o temporizador e a requisição
 * anteriores; a sequência (`rodada`) descarta qualquer resposta que chegue
 * depois de uma digitação mais nova.
 */

type Estado =
  | { readonly _tag: 'Ocioso' }
  | { readonly _tag: 'Curto' }
  | { readonly _tag: 'Buscando' }
  | { readonly _tag: 'Resultados'; readonly empresas: readonly EmpresaResumo[] }
  | { readonly _tag: 'NenhumResultado' }
  | { readonly _tag: 'ConsultandoCnpj' }
  | { readonly _tag: 'Aviso'; readonly mensagem: string };

export const ATRASO_DA_BUSCA_MS = 400;

const SEM_BUSCA = 'Não foi possível pesquisar empresas agora. Você ainda pode preencher o cadastro manualmente ou informar o CNPJ.';
const SEM_BUSCA_POR_NOME = 'A busca por nome não está disponível. Informe o CNPJ para preencher os dados, ou preencha o cadastro manualmente.';
const SEM_CONSULTA = 'Não foi possível consultar o CNPJ agora. Você ainda pode preencher o cadastro manualmente.';
const MUITAS_CONSULTAS = 'Muitas consultas em pouco tempo. Aguarde um instante e tente de novo.';

function rotuloDaEmpresa(empresa: EmpresaResumo): { titulo: string; subtitulo: string | null; detalhe: string } {
  const titulo = empresa.nomeFantasia || empresa.razaoSocial;
  const local = [empresa.municipio, empresa.uf].filter(Boolean).join('/');
  return {
    titulo,
    subtitulo: empresa.nomeFantasia ? empresa.razaoSocial : null,
    detalhe: [formatarCnpj(empresa.cnpj), local, empresa.situacao].filter(Boolean).join(' • '),
  };
}

export function BuscaDeEmpresa({
  buscar,
  onEmpresa,
  atrasoMs = ATRASO_DA_BUSCA_MS,
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

  const cancelarAnterior = () => {
    if (temporizador.current) clearTimeout(temporizador.current);
    controle.current?.abort();
    rodada.current += 1;
    return rodada.current;
  };

  useEffect(() => () => {
    if (temporizador.current) clearTimeout(temporizador.current);
    controle.current?.abort();
  }, []);

  /** Consulta completa por CNPJ; só a rodada atual pode mexer no estado. */
  const completarPorCnpj = async (cnpj: string, minha: number) => {
    const sinal = new AbortController();
    controle.current = sinal;
    setEstado({ _tag: 'ConsultandoCnpj' });
    try {
      const r = await consultarCnpj(cnpj, buscar, sinal.signal);
      if (minha !== rodada.current) return;
      if (r.resultado === 'EmpresaEncontrada') {
        setEstado({ _tag: 'Ocioso' });
        onEmpresa(r.empresa);
      } else if (r.resultado === 'EmpresaNaoEncontrada' || r.resultado === 'CnpjInvalido') {
        setEstado({ _tag: 'Aviso', mensagem: 'CNPJ não encontrado na Receita Federal.' });
      } else {
        setEstado({ _tag: 'Aviso', mensagem: r.resultado === 'LimiteDeConsultas' ? MUITAS_CONSULTAS : SEM_CONSULTA });
      }
    } catch {
      if (minha === rodada.current) setEstado({ _tag: 'Aviso', mensagem: SEM_CONSULTA });
    }
  };

  const pesquisarNome = async (termo: string, minha: number) => {
    const sinal = new AbortController();
    controle.current = sinal;
    try {
      const r = await buscarEmpresas(termo, buscar, sinal.signal);
      if (minha !== rodada.current) return;
      if (r.resultado === 'Empresas') {
        setEstado(r.empresas.length > 0 ? { _tag: 'Resultados', empresas: r.empresas } : { _tag: 'NenhumResultado' });
      } else if (r.resultado === 'BuscaPorNomeIndisponivel') {
        setEstado({ _tag: 'Aviso', mensagem: SEM_BUSCA_POR_NOME });
      } else {
        setEstado({ _tag: 'Aviso', mensagem: r.resultado === 'LimiteDeConsultas' ? MUITAS_CONSULTAS : SEM_BUSCA });
      }
    } catch {
      if (minha === rodada.current) setEstado({ _tag: 'Aviso', mensagem: SEM_BUSCA });
    }
  };

  const aoDigitar = (valor: string) => {
    setTexto(valor);
    const minha = cancelarAnterior();
    const intencao = intencaoDaBusca(valor);
    if (intencao._tag === 'Curto') {
      setEstado(valor.trim() === '' ? { _tag: 'Ocioso' } : { _tag: 'Curto' });
      return;
    }
    setEstado({ _tag: 'Buscando' });
    temporizador.current = setTimeout(() => {
      void (intencao._tag === 'Cnpj' ? completarPorCnpj(intencao.cnpj, minha) : pesquisarNome(intencao.termo, minha));
    }, atrasoMs);
  };

  const aoEscolher = (empresa: EmpresaResumo) => {
    // O resumo não basta para preencher: a escolha leva à consulta completa por CNPJ.
    void completarPorCnpj(empresa.cnpj, cancelarAnterior());
  };

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="cliente-busca-empresa" className="orbita-eyebrow">Buscar empresa</label>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'var(--txt3)' }} aria-hidden />
        <input
          id="cliente-busca-empresa"
          type="search"
          autoComplete="off"
          value={texto}
          maxLength={80}
          onChange={(e) => aoDigitar(e.target.value)}
          className="orbita-campo"
          style={{ paddingLeft: 34 }}
          placeholder="Digite nome, razão social, nome fantasia ou CNPJ"
          aria-describedby="cliente-busca-empresa-ajuda"
        />
        {(estado._tag === 'Buscando' || estado._tag === 'ConsultandoCnpj') && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin" style={{ color: 'var(--txt2)' }} aria-hidden />
        )}
      </div>
      <span id="cliente-busca-empresa-ajuda" className="text-[11px]" style={{ color: 'var(--txt3)' }}>
        Encontre a empresa e preencha os dados automaticamente.
      </span>

      <output aria-live="polite" className="text-[11px]" style={{ color: estado._tag === 'Aviso' ? 'var(--warning)' : 'var(--txt2)' }}>
        {estado._tag === 'Curto' && 'Digite ao menos 3 caracteres.'}
        {estado._tag === 'Buscando' && 'Buscando…'}
        {estado._tag === 'ConsultandoCnpj' && 'Consultando os dados completos do CNPJ…'}
        {estado._tag === 'NenhumResultado' && 'Nenhuma empresa encontrada.'}
        {estado._tag === 'Aviso' && estado.mensagem}
      </output>

      {estado._tag === 'Resultados' && (
        <ul aria-label="Empresas encontradas" className="m-0 p-0 list-none flex flex-col gap-1">
          {estado.empresas.map((empresa) => {
            const { titulo, subtitulo, detalhe } = rotuloDaEmpresa(empresa);
            return (
              <li key={empresa.cnpj}>
                <button
                  type="button"
                  onClick={() => aoEscolher(empresa)}
                  className="w-full text-left flex items-start gap-2 px-3 py-2 cursor-pointer"
                  style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)' }}
                >
                  <Building2 className="w-4 h-4 mt-0.5 shrink-0" style={{ color: 'var(--txt3)' }} aria-hidden />
                  <span className="flex flex-col min-w-0">
                    <span className="text-xs font-semibold truncate" style={{ color: 'var(--txt)' }}>{titulo}</span>
                    {subtitulo && <span className="text-[11px] truncate" style={{ color: 'var(--txt2)' }}>{subtitulo}</span>}
                    <span className="text-[11px] font-mono" style={{ color: 'var(--txt3)' }}>{detalhe}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Depois de preencher: conferir antes de salvar. O nome fantasia só vira o
 * nome do contato por decisão explícita; o tipo de contribuinte não é
 * deduzido do CNPJ.
 */
export function AvisoDePreenchimento({
  nomeFantasia,
  mantidos,
  onUsarNomeFantasia,
}: {
  nomeFantasia: string | null;
  mantidos: readonly string[];
  onUsarNomeFantasia: () => void;
}) {
  return (
    <output
      className="flex flex-col gap-1.5 px-4 py-2.5 text-xs"
      style={{ borderRadius: 'var(--r-chip)', background: 'var(--chip)', border: '1px solid var(--line)', color: 'var(--txt2)' }}
    >
      <span className="font-semibold" style={{ color: 'var(--accent)' }}>Dados encontrados. Confira antes de salvar.</span>
      {mantidos.length > 0 && <span>Mantidos os campos que você já tinha preenchido: {mantidos.join(', ')}.</span>}
      <span>Confira o tipo de contribuinte: o CNPJ não indica se a empresa é contribuinte de ICMS.</span>
      {nomeFantasia && (
        <span className="flex flex-wrap items-center gap-2">
          Nome fantasia: <strong style={{ color: 'var(--txt)' }}>{nomeFantasia}</strong>
          <button type="button" onClick={onUsarNomeFantasia} className="orbita-chip cursor-pointer">
            Usar nome fantasia como nome
          </button>
        </span>
      )}
    </output>
  );
}
