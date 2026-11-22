import {MensageriaDesktop} from '@/components/mensageria/MensageriaDesktop';
import React,{useState} from 'react';
import { ProductDetailModal } from '@/components/ProductDetailModal';
import { ClienteEditModal } from '@/components/ClienteEditModal';
import { ManualOrderModal } from '@/components/ManualOrderModal';
import { DetalhesDaMovimentacao } from '@/components/financeiro/DetalheDaMovimentacao';
import { IntegrationsPanel } from '@/components/integracoes/IntegrationsPanel';
import { BillingPanel } from '@/components/billing/BillingPanel';
import { MembersList } from '@/components/organizacao/MembersList';
import { SeletorDeFundo } from '@/components/shell/SeletorDeFundo';
import { VisaoGeral } from '@/components/painel/VisaoGeral';
import { FinanceiroTab } from '@/components/financeiro/FinanceiroTab';
import { fetchWithAuth,forbidden,reads,writes } from './ports';
const espelho={async lerConversas(){return [{id_local:'22222222-2222-4222-8222-222222222222',contato_id_local:'33333333-3333-4333-8333-333333333333',status:'open',contact:{name:'Cliente sintético D07'},updated_at:'2026-11-19T12:00:00Z'}];},async lerMensagens(){return [{id_local:'44444444-4444-4444-8444-444444444444',conversa_id_local:'22222222-2222-4222-8222-222222222222',content:'Olá! Mensagem exclusivamente sintética.',message_type:'incoming',created_at:'2026-11-19T12:00:00Z'}];},assinarConversas(_a,_b,estado){estado(true);return()=>{};},assinarMensagens(_a,_b,_c,estado){estado(true);return()=>{};}};
const id='11111111-1111-4111-8111-111111111111';
window.d07Fixtures={reads,writes};
export function SurfaceHarness(){
 const [open,setOpen]=useState(null),[fundo,setFundo]=useState('armazem');
 return <section aria-label="Superfícies reais com portas falsas"><h2>Componentes reais — dados sintéticos, sem serviços</h2>
 {['produto','contato','pedido','financeiro','integracoes','organizacao','plano','painel','filtros','sac'].map(x=><button key={x} type="button" onClick={()=>setOpen(x)}>Inspecionar {x}</button>)}
 <SeletorDeFundo fundo={fundo} onEscolher={setFundo}/>
 {open==='sac'&&<div aria-label="Cockpit sintético" style={{display:'flex',height:560,minHeight:0}}><MensageriaDesktop fetchWithAuth={fetchWithAuth} selecao={{id,versao:1}} espelho={espelho}/></div>}
 {open==='produto'&&<ProductDetailModal isOpen onClose={()=>setOpen(null)} produto={{id,nome:'Produto sintético',codigo:'D07',bling_id:'LOCAL-1',preco:12,estoque:3,unidade:'UN'}} cliente={null}/>}
 {open==='contato'&&<ClienteEditModal isOpen onClose={()=>setOpen(null)} cliente={null}/>}
 {open==='pedido'&&<ManualOrderModal open onOpenChange={v=>{if(!v)setOpen(null);}} onSuccess={forbidden} organizacaoId={id}/>}
 {open==='financeiro'&&<DetalhesDaMovimentacao titulo={{id,tipo:'pagar',situacao:'aberto',titulo:'Saída sintética',descricao:'Somente inspeção visual',valor:12,data_vencimento:'2026-11-18',data_pagamento:null,bling_id:null,pedido_id:null}} pedidoLocal={null} onFechar={()=>setOpen(null)} formatarDinheiro={v=>`R$ ${v}`} onCorrigir={forbidden}/>}
 {open==='integracoes'&&<IntegrationsPanel fetchWithAuth={fetchWithAuth} selecao={{id,versao:1}} nomeDaOrganizacao="Organização sintética" podeGerir={false} onRedirect={forbidden}/>}
 {open==='organizacao'&&<MembersList membros={[]} carregando={false} erroDeLeitura={null} erroDeAcao={null} canManage={false} onRemove={forbidden} onRecarregar={()=>{}}/>}
 {open==='plano'&&<BillingPanel fetchWithAuth={fetchWithAuth} organizacaoId={id} onRedirect={forbidden}/>}
 {open==='painel'&&<VisaoGeral dados={{pedidos:[],produtos:[],clientes:[]}} erroDeLeitura={null} onRecarregar={forbidden}/>}
 {open==='filtros'&&<FinanceiroTab fetchWithAuth={fetchWithAuth} organizacaoId={id}/>}
 </section>;
}
