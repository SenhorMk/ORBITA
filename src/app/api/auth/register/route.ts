import { NextResponse } from 'next/server';
import { supabaseServer } from '../../../../lib/supabaseServer';

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

    // Cadastro padrão sem elevação indevida de privilégios ou auto-confirmação via service_role admin
    const { data, error } = await supabaseServer.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: name,
        },
      },
    });

    if (error) {
      console.error('Erro ao registrar usuário:', error);
      let errorMessage = 'Erro ao criar conta. Tente novamente mais tarde.';
      if (error.message.includes('already registered')) {
        errorMessage = 'Este e-mail já está cadastrado. Tente fazer login.';
      }
      return NextResponse.json({ success: false, error: errorMessage }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      message: 'Conta criada com sucesso. Verifique seu e-mail para confirmar seu cadastro se aplicável.',
      user: data.user ? { id: data.user.id, email: data.user.email } : null,
    });

  } catch (error: unknown) {
    console.error('Erro crítico no endpoint de registro:', error);
    return NextResponse.json(
      { success: false, error: 'Falha interna no servidor ao processar o cadastro.' },
      { status: 500 }
    );
  }
}
