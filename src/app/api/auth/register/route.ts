import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { email, password, name } = await request.json();

    if (!email || !password || !name) {
      return NextResponse.json(
        { success: false, error: 'E-mail, senha e nome são obrigatórios.' },
        { status: 400 }
      );
    }

    if (password.length < 6) {
      return NextResponse.json(
        { success: false, error: 'A senha deve ter pelo menos 6 caracteres.' },
        { status: 400 }
      );
    }

    // Cria o usuário usando a API de Administração (Service Role)
    // Isso nos permite forçar o app_metadata com a role de 'dono', o que
    // isola este tenant e garante que o backend confie nos privilégios dele.
    const { data, error } = await supabaseServer.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirmamos o email para simplificar o onboarding
      user_metadata: {
        full_name: name
      },
      app_metadata: {
        role: 'dono'
      }
    });

    if (error) {
      console.error('Erro ao criar usuário admin via API:', error);
      // Retornar mensagens de erro amigáveis
      let errorMessage = 'Erro ao criar conta. Tente novamente mais tarde.';
      if (error.message.includes('already registered')) {
        errorMessage = 'Este e-mail já está cadastrado. Tente fazer login.';
      }
      return NextResponse.json({ success: false, error: errorMessage }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Conta criada com sucesso. Você já pode fazer login!',
      user: data.user
    });

  } catch (error: any) {
    console.error('Erro crítico no endpoint de registro:', error);
    return NextResponse.json(
      { success: false, error: 'Falha interna no servidor ao processar o cadastro.' },
      { status: 500 }
    );
  }
}
