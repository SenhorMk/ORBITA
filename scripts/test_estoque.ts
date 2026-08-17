import { BlingClient } from '../src/services/bling';
import { resolveActorContext } from '../src/lib/auth';
import * as dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env.local') });

async function run() {
  const accessToken = process.env.ORBITA_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('ORBITA_ACCESS_TOKEN is required to resolve a verified tenant.');
  }

  const contextResult = await resolveActorContext(
    new Request('https://orbita.local/scripts/test-estoque', {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    'tenant:manage',
  );
  if (contextResult._tag !== 'ActorContextResolved') {
    throw new Error(`Authorization denied: ${contextResult._tag}`);
  }

  const bling = BlingClient.forUser(contextResult.context.tenant);
  const pedidos = await bling.getPedidos(1, 1);
  console.log('Latest order:', pedidos[0]?.id ?? 'none');
}

run().catch(console.error);
