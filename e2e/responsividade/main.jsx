import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import './compat-157.css';
import responsive from '@/components/ui/Responsive.module.css';
import { AppWindow } from '@/components/shell/AppWindow';
import { AreaDeConteudo } from '@/components/shell/AreaDeConteudo';
import { Rail } from '@/components/shell/Rail';
import { OrganizacaoAtiva } from '@/components/shell/OrganizacaoAtiva';
import { SeletorDeFundo } from '@/components/shell/SeletorDeFundo';
import { HelpContext } from '@/components/help/HelpContext';
import { FinanceiroTab } from '@/components/financeiro/FinanceiroTab';
import { VisaoGeral } from '@/components/painel/VisaoGeral';
import { VendasEPedidos } from '@/components/vendas/VendasEPedidos';
import { EstoqueEProdutos } from '@/components/estoque/EstoqueEProdutos';
import { OrganizationPanel } from '@/components/organizacao/OrganizationPanel';
import { IntegrationsPanel } from '@/components/integracoes/IntegrationsPanel';
import { id, lista, pedidos, produtos, cliente } from './data';
import { fetchWithAuth, forbidden, writes } from './ports';

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'dark';
document.documentElement.dataset.future = params.get('future') ?? '';
window.inspecaoResponsiva = { writes };
function App() {
  const [tab, setTab] = useState(params.get('tela') ?? 'finance');
  const [fundo, setFundo] = useState('armazem');
  const [busca, setBusca] = useState('');
  return <AppWindow>
    <Rail activeTab={tab} setActiveTab={setTab} session={{ name:'Inspeção', email:'visual@example.invalid' }} onLogout={forbidden} />
    <div className="orbita-conteudo">
      <div className={`orbita-acoes ${responsive.topbar}`}>
        <HelpContext ajudaId="shell.org"><OrganizacaoAtiva organizacoes={lista.organizacoes} ativa={lista.activeOrg} carregando={false} trocandoParaId={null} onTrocar={forbidden}/></HelpContext>
        <SeletorDeFundo fundo={fundo} onEscolher={setFundo}/>
        <HelpContext ajudaId="integracoes.estado-job"><button className="orbita-acao" onClick={forbidden}>Sincronizar Bling</button></HelpContext>
      </div>
      <AreaDeConteudo aba={tab}>
        <div className={tab==='finance' ? 'flex flex-col flex-1 min-h-0' : 'hidden'}><FinanceiroTab fetchWithAuth={fetchWithAuth} ativo={tab==='finance'} organizacaoId={id}/></div>
        {tab==='dashboard' && <VisaoGeral dados={{pedidos,produtos,clientes:[cliente]}} erroDeLeitura={null} onRecarregar={forbidden}/>}
        {tab==='sales' && <VendasEPedidos pedidos={pedidos} carregando={false} erroDeLeitura={null} onRecarregar={forbidden} organizacaoId={id} ultimaSincronizacao={null} busca={busca} onBuscaChange={setBusca} onConversarNoWhatsapp={forbidden} onEmitirNfe={forbidden}/>}
        {tab==='inventory' && <EstoqueEProdutos produtos={produtos} categorias={[]} carregando={false} erroDeLeitura={null} onRecarregar={forbidden} onAbrirProduto={forbidden} onCadastrarProduto={forbidden}/>}
        {tab==='organization' && <div className="flex flex-col flex-1 min-h-0"><OrganizationPanel fetchWithAuth={fetchWithAuth} lista={lista}/></div>}
        {tab==='integrations' && <div className="flex flex-col flex-1 min-h-0"><IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={{id,versao:1}} nomeDaOrganizacao={lista.activeOrg.organizacao.nome} podeGerir={false}/></div>}
      </AreaDeConteudo>
    </div>
  </AppWindow>;
}
createRoot(document.getElementById('root')).render(<App/>);
