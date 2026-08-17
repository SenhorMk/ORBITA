import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { supabaseServer } from '@/lib/supabaseServer';
import { verifySessionAndRole } from '@/lib/auth';

export async function POST(request: Request) {
  try {
    const session = await verifySessionAndRole(request);
    if (!session) {
      return NextResponse.json({ success: false, error: 'Não autorizado' }, { status: 401 });
    }
    const blingClient = bling.forUser(session.tenant);

    const categorias = await blingClient.getCategoriasProdutos(1, 100);
    
    if (!categorias || categorias.length === 0) {
      return NextResponse.json({ success: true, message: 'Nenhuma categoria encontrada no Bling.' });
    }

    const upsertPromises = categorias.map(async (cat) => {
      const payload = {
        bling_id: String(cat.id),
        descricao: cat.descricao,
        categoria_pai_id: cat.categoriaPai?.id ? String(cat.categoriaPai.id) : null,
      };

      const { data, error } = await supabaseServer
        .from('categorias')
        .upsert(payload, { onConflict: 'bling_id' })
        .select();
        
      if (error) {
        console.error(`Erro ao inserir categoria ${cat.id}:`, error);
      }
      return data;
    });

    await Promise.all(upsertPromises);

    return NextResponse.json({ success: true, count: categorias.length, message: 'Categorias sincronizadas com sucesso' });
  } catch (error: any) {
    console.error('Erro na sincronização de categorias:', error);
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { data, error } = await supabaseServer
      .from('categorias')
      .select('*')
      .order('descricao', { ascending: true });

    if (error) throw error;

    return NextResponse.json({ success: true, data });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}
