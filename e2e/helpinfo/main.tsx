import React, { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import { HelpInfo } from '@/components/help/HelpInfo';
import { catalogoDeAjuda as catalogo } from '@/components/help/catalogo';
import { NovaDespesaModal } from '@/components/financeiro/NovaDespesaModal';
import { NovoFornecedorModal } from '@/components/financeiro/NovoFornecedorModal';
import { DetalhesDaMovimentacao } from '@/components/financeiro/DetalheDaMovimentacao';
import { ResumoFinanceiro } from '@/components/financeiro/ResumoFinanceiro';
import { SurfaceHarness } from './surfaces';

function App() {
  const [tela, setTela] = useState('inicio');
  const [modo, setModo] = useState<'contabil' | 'interno'>('interno');
  const [dropdown, setDropdown] = useState(false);
  const [busca, setBusca] = useState('');
  const [cnpj, setCnpj] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const semEscrita = () => { throw new Error('Esta inspeção não permite gravar operações'); };
  return <main style={{ padding: 24, minHeight: '100vh', background: 'var(--glass2)', color: 'var(--txt)' }}>
    <h1>Revisão visual HelpInfo — dados sintéticos</h1>
    <nav aria-label="Inspeção" className="flex flex-wrap gap-2 my-4">
      {['inicio', 'despesa', 'fornecedor', 'detalhe', 'cancelamento', 'galeria'].map(t => <button className="orbita-chip" key={t} onClick={() => setTela(t)}>{t}</button>)}
      <button className="orbita-chip" onClick={() => { document.documentElement.dataset.theme = 'light'; }}>Tema claro</button>
      <button className="orbita-chip" onClick={() => { document.documentElement.dataset.theme = 'dark'; }}>Tema escuro</button>
    </nav>
    <ResumoFinanceiro resumo={{ receitas: 150, despesas: 30, saldo: 120 }} formatarDinheiro={v => `R$ ${v.toFixed(2)}`} />
    {tela === 'inicio' && <SurfaceHarness />}
    {tela === 'galeria' && <section className="grid gap-3 mt-6" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
      {Object.entries(catalogo).map(([id, item]) => <div className="flex items-center gap-2" key={id}><span>{item.titulo}</span><HelpInfo ajudaId={id as keyof typeof catalogo} /></div>)}
    </section>}
    <NovaDespesaModal isOpen={tela === 'despesa'} onClose={() => setTela('inicio')} modoLancamento={modo} setModoLancamento={setModo} syncing={false} onSubmit={e => { e.preventDefault(); semEscrita(); }} categorias={[]}
      fornecedorPicker={{ fornecedorSelecionado: null, showFornecedorDropdown: dropdown, setShowFornecedorDropdown: setDropdown, dropdownRef, fornecedorSearchInputRef: searchRef, searchFornecedor: busca, setSearchFornecedor: setBusca, fornecedoresFiltrados: [], setFornecedorSelecionado: semEscrita, onCadastrarNovo: () => setTela('fornecedor') }} />
    <NovoFornecedorModal isOpen={tela === 'fornecedor'} onVoltar={() => setTela('despesa')} cnpj={cnpj} onCNPJChange={e => setCnpj(e.target.value)} dadosCNPJ={null} buscandoCNPJ={false} erroCNPJ="" salvandoFornecedor={false} onSalvar={semEscrita} />
    {(tela === 'detalhe' || tela === 'cancelamento') && <DetalhesDaMovimentacao titulo={{ id: '11111111-1111-4111-8111-111111111111', tipo: 'pagar', situacao: 'aberto', titulo: 'Saída de inspeção visual', descricao: 'Sem alteração de dados comerciais', valor: 30, data_vencimento: '2026-11-23', bling_id: tela === 'cancelamento' ? 123 : 0, pedido_id: null }} pedidoLocal={null} onFechar={() => setTela('inicio')} formatarDinheiro={v => `R$ ${v.toFixed(2)}`} onCorrigir={semEscrita} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
