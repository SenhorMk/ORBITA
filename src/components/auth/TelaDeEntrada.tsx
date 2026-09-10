'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

import { RegisterForm } from './RegisterForm';

/**
 * A primeira tela do ORBITA, nos tokens do Design System.
 *
 * ---------------------------------------------------------------------------
 * O QUE SAIU, E POR QUÊ
 * ---------------------------------------------------------------------------
 * Esta tela ficou para trás quando o resto do produto migrou no Ticket 01, e
 * continuava anunciando três coisas que não são o produto:
 *
 * - **"Ecosistema ERP Bling & Chatwoot"**, logo abaixo do nome. O Bling e o
 *   Chatwoot são executores de onde o ORBITA escreve e lê; dizer isso como
 *   subtítulo da marca lê como "isto é uma integração de terceiros", que é
 *   justamente a leitura errada;
 * - **"Acesso Autenticado"** e **"Entre com sua conta Supabase"**. Quem entra
 *   tem conta no ORBITA. O provedor de identidade é detalhe de implementação, e
 *   nomeá-lo na porta de entrada faz o produto parecer o painel de outra pessoa;
 * - **"E-mail / Usuário Dev"**, **"Senha Credencial"** e os placeholders
 *   `dev: admin` / `dev: admin0`. Um atalho interno impresso no campo de uma
 *   tela pública.
 *
 * ---------------------------------------------------------------------------
 * O QUE **NÃO** MUDOU
 * ---------------------------------------------------------------------------
 * O mecanismo de autenticação, inteiro. Esta tela não sabe autenticar: ela
 * recebe `onSubmit` e o chama. Quem decide continua sendo `handleLogin`, com o
 * mesmo `signInWithPassword` e o mesmo atalho de desenvolvimento — que segue
 * funcionando exatamente como antes, só que sem estar escrito na porta. Deixar
 * de anunciar não é deixar de suportar.
 *
 * Os `id` dos três controles (`email-input`, `password-input`,
 * `btn-login-submit`, `btn-auth-mode-toggle`) são preservados: eles são o
 * contrato que a suíte E2E usa para entrar, e trocá-los aqui cegaria a suíte
 * inteira do mesmo jeito que os rótulos antigos do rail cegaram (Ticket 09).
 */
export interface TelaDeEntradaProps {
  readonly modo: 'signin' | 'signup';
  readonly onTrocarModo: () => void;
  readonly email: string;
  readonly onEmailChange: (valor: string) => void;
  readonly senha: string;
  readonly onSenhaChange: (valor: string) => void;
  readonly onSubmit: (evento: React.FormEvent) => void;
  readonly erro: string | null;
  readonly carregando: boolean;
  /** A marca do produto, desenhada por quem já a tem. */
  readonly logo: ReactNode;
}

export function TelaDeEntrada({
  modo,
  onTrocarModo,
  email,
  onEmailChange,
  senha,
  onSenhaChange,
  onSubmit,
  erro,
  carregando,
  logo,
}: TelaDeEntradaProps) {
  const entrando = modo === 'signin';

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full" style={{ maxWidth: 420 }}>
        {/* A marca, e só ela. Sem subtítulo explicando de quem é o ERP. */}
        <div className="flex flex-col items-center" style={{ gap: 14, marginBottom: 26 }}>
          <span
            className="flex items-center justify-center"
            style={{
              width: 56,
              height: 56,
              borderRadius: 18,
              background: 'var(--chip)',
              border: '1px solid var(--line)',
            }}
          >
            {logo}
          </span>
          <span
            style={{
              fontFamily: 'var(--font-space-grotesk), sans-serif',
              fontWeight: 500,
              fontSize: 27,
              lineHeight: 1,
              letterSpacing: '-0.03em',
              color: 'var(--txt)',
            }}
          >
            ORBITA
          </span>
        </div>

        {/* Um cartão só, na elevação de diálogo do Design System. */}
        <div
          className="flex flex-col"
          style={{
            gap: 20,
            padding: 28,
            borderRadius: 'var(--r-modal)',
            background: 'var(--modal)',
            border: '1px solid var(--line)',
            boxShadow: 'var(--shadow-modal)',
          }}
        >
          <div className="flex flex-col" style={{ gap: 6 }}>
            <span className="orbita-eyebrow">{entrando ? 'Entrar' : 'Criar conta'}</span>
            <h1
              className="m-0"
              style={{
                fontFamily: 'var(--font-space-grotesk), sans-serif',
                fontWeight: 500,
                fontSize: 23,
                lineHeight: 1.1,
                letterSpacing: '-0.02em',
                color: 'var(--txt)',
              }}
            >
              {entrando ? 'Entrar no ORBITA' : 'Criar conta no ORBITA'}
            </h1>
            <p className="m-0" style={{ fontSize: 12.5, color: 'var(--txt2)' }}>
              {entrando
                ? 'Use o e-mail e a senha da sua conta.'
                : 'Cadastre-se para começar. Você receberá um e-mail de confirmação.'}
            </p>
          </div>

          {erro && entrando && (
            <div
              className="flex items-start gap-2"
              style={{
                padding: '10px 12px',
                borderRadius: 'var(--r-chip)',
                background: 'color-mix(in srgb, var(--danger) 14%, transparent)',
                border: '1px solid color-mix(in srgb, var(--danger) 34%, transparent)',
                color: 'var(--danger)',
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              <span>{erro}</span>
            </div>
          )}

          {entrando ? (
            <form onSubmit={onSubmit} className="flex flex-col" style={{ gap: 14 }}>
              <div className="flex flex-col" style={{ gap: 5 }}>
                <label htmlFor="email-input" className="orbita-eyebrow">
                  E-mail
                </label>
                <input
                  id="email-input"
                  // `text`, e não `email`, de propósito: a validação nativa do
                  // navegador recusaria o atalho interno de desenvolvimento, que
                  // continua existindo e não é um endereço. Trocar o tipo aqui
                  // desligaria em silêncio um caminho que ninguém pediu para
                  // remover.
                  type="text"
                  inputMode="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(evento) => onEmailChange(evento.target.value)}
                  placeholder="voce@empresa.com.br"
                  className="orbita-campo"
                />
              </div>

              <div className="flex flex-col" style={{ gap: 5 }}>
                <label htmlFor="password-input" className="orbita-eyebrow">
                  Senha
                </label>
                <input
                  id="password-input"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={senha}
                  onChange={(evento) => onSenhaChange(evento.target.value)}
                  placeholder="••••••••"
                  className="orbita-campo"
                />
              </div>

              <button
                id="btn-login-submit"
                type="submit"
                disabled={carregando}
                className="orbita-chip cursor-pointer justify-center"
                style={{
                  height: 'var(--h-field)',
                  marginTop: 4,
                  background: 'var(--accent)',
                  borderColor: 'var(--accent)',
                  color: 'var(--accent-fg)',
                  fontSize: 13,
                }}
              >
                {carregando ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {carregando ? 'Entrando…' : 'Entrar'}
              </button>
            </form>
          ) : (
            <RegisterForm />
          )}

          <div className="text-center" style={{ fontSize: 12, color: 'var(--txt2)' }}>
            {entrando ? 'Ainda não tem conta?' : 'Já tem uma conta?'}{' '}
            <button
              id="btn-auth-mode-toggle"
              type="button"
              onClick={onTrocarModo}
              className="cursor-pointer underline underline-offset-4"
              style={{ color: 'var(--txt)', fontWeight: 600 }}
            >
              {entrando ? 'Criar conta' : 'Entrar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
