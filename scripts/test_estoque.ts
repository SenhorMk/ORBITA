import { BlingClient } from '../src/services/bling';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

async function run() {
  const bling = new BlingClient();
  
  // Create a dummy order to get a real ID, or get the latest order
  console.log('Fetching orders...');
  const res = await (bling as any).fetchWithAuth('https://api.bling.com.br/Api/v3/pedidos/vendas?limite=1');
  const json = await res.json();
  const pedido = json.data[0];
  console.log('Got pedido:', pedido.id);

  console.log('Launching stock...');
  const url = `https://api.bling.com.br/Api/v3/pedidos/vendas/${pedido.id}/lancamentos-estoque`;
  const response = await (bling as any).fetchWithAuth(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const text = await response.text();
  console.log('Status:', response.status);
  console.log('Response:', text);
}

run().catch(console.error);
