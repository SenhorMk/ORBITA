// Portas determinísticas EXCLUSIVAS do harness visual; não comprovam serviços reais.
export const reads = [];
export const writes = [];
const id='11111111-1111-4111-8111-111111111111';
export async function fetchWithAuth(url, options={}) {
 const method=options.method??'GET';
 if(method!=='GET'){writes.push({url,method});throw new Error('Escrita proibida no harness D07');}
 reads.push(url);
 let body;
 if(url.startsWith('/api/produtos/movimentacoes')) body={success:true,movimentacoes:[{id,tipo:'SAIDA',origem:'BAIXA_ORGANIZACAO_VERIFICADA',quantidade:1,created_at:'2026-11-19T12:00:00Z'}]};
 else if(url.startsWith('/api/chatwoot/controle')) body={success:true,controle:{modo:'HUMAN',responsavelId:id,souResponsavel:true,versao:9},permissoes:{devolver:true,automacaoAtiva:true}};
 else if(url.startsWith('/api/chatwoot/send')) body={success:true,envios:[]};
 else if(url.startsWith('/api/sac/triagem')) body={success:true,versao:1,caso:{id,fase:'TRIAGE',pendente:false,execucao:null}};
 else if(url.startsWith('/api/sac/verificacao')) body={success:true,versao:1,candidatos:[],verificacao:{estado:'sem_prova',cliente:null,verificadoEm:null,expiraEm:null,totalDeCandidatos:0,consultaPorNumeroBloqueada:false}};
 else if(url.includes('categorias/sync')) body={success:true,data:[{id,descricao:'Categoria sintética'}]};
 else if(url.includes('/entitlements')) body={entitlements:{plano_nome:'Plano sintético',plano_slug:'starter',status:'trial',limite_membros:3,limite_conexoes_bling:1,limite_conexoes_chatwoot:1,periodo_fim:null}};
 else if(url.includes('/integracoes/saude')) body={success:true,conexoes:[],bling_callback_url:'https://example.invalid/callback',chatwoot_webhook_url:null};
 else if(url.includes('/integracoes/outbox')) body={success:true,eventos:[]};
 else if(url.includes('/sac/casos')) body={success:true,eventos:[],casos:[]};
 else if(url.startsWith('/api/financeiro/operacoes')) body={success:true,operacoes:[],resultados:[],total:0,incompleta:false,proximoCursor:null};
 else if(url.startsWith('/api/financeiro')) body={success:true,data:{titulos:[],categorias:[],resumo:{receitas:0,despesas:0,saldo:0}}};
 else throw new Error('Leitura não prevista no harness: '+url);
 return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
}
export const supabase={
 from(table){const query={select(){return this;},is(){return this;},eq(){return this;},async order(){reads.push('fixture:'+table);return {data:[],error:null};}};return query;},
 auth:{async getSession(){return {data:{session:null}};}}
};
export function forbidden(){writes.push({operation:'callback'});throw new Error('Operação proibida no harness');}
export default function FixtureImage(){return null;}
