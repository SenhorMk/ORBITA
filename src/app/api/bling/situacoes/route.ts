import { NextResponse } from 'next/server';
import { bling } from '@/services/bling';
import { supabaseServer } from '@/lib/supabaseServer';

export async function GET(request: Request) {
  try {
    const { data: { session }, error: sessionError } = await supabaseServer.auth.getSession();
    
    if (sessionError || !session) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 });
    }

    const userId = session.user.id;
    const blingClient = userId ? bling.forUser(userId) : bling;
    
    const situacoes = await blingClient.getSituacoesModulo(9);
    
    return NextResponse.json(situacoes);
  } catch (error: any) {
    console.error('Erro ao buscar situações no Bling:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
