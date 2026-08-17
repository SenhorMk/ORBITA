import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';

// Load .env.local
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const rawKey = process.env.ENCRYPTION_KEY || '0000000000000000000000000000000000000000000000000000000000000000';
const KEY = Buffer.from(rawKey, 'hex');

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase URL or Key in env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

function encrypt(text: string | null | undefined): string | null {
  if (!text) return null;
  // If already encrypted, skip
  if (text.includes(':')) {
      const parts = text.split(':');
      if (parts.length === 3 && parts[0].length === 24 && parts[1].length === 32) {
          return text;
      }
  }
  
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

async function run() {
  console.log('Starting backfill of encrypted secrets...');

  const { data, error } = await supabase
    .from('integracoes_bling')
    .select('id, client_secret, access_token, refresh_token');

  if (error) {
    console.error('Error fetching data:', error);
    process.exit(1);
  }

  if (!data || data.length === 0) {
    console.log('No records found.');
    return;
  }

  console.log(`Found ${data.length} records. Processing...`);

  let updated = 0;
  for (const row of data) {
    const encSecret = encrypt(row.client_secret);
    const encAccess = encrypt(row.access_token);
    const encRefresh = encrypt(row.refresh_token);

    if (
      encSecret !== row.client_secret ||
      encAccess !== row.access_token ||
      encRefresh !== row.refresh_token
    ) {
      const { error: updateErr } = await supabase
        .from('integracoes_bling')
        .update({
          client_secret: encSecret,
          access_token: encAccess,
          refresh_token: encRefresh,
        })
        .eq('id', row.id);

      if (updateErr) {
        console.error(`Error updating record ${row.id}:`, updateErr);
      } else {
        console.log(`Successfully encrypted record ${row.id}`);
        updated++;
      }
    } else {
      console.log(`Record ${row.id} already encrypted or empty.`);
    }
  }

  console.log(`Backfill complete. Updated ${updated} records.`);
}

run().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
