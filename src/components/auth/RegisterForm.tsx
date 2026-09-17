'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

/** What the form is currently telling the user, if anything. */
type RegisterFeedback =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Submitted'; readonly message: string }
  | { readonly _tag: 'Rejected'; readonly message: string };

/**
 * Message shown when the server accepted the attempt.
 *
 * `/api/auth/register` answers identically for a new address and
 * an address that already has an account. This copy preserves that property on
 * the client: it never says whether an account was created, so the screen can
 * not be used to enumerate registered e-mails. Never replace it with anything
 * conditional on the address.
 */
const FALLBACK_SUBMITTED_MESSAGE =
  'Se os dados informados forem válidos, você receberá um e-mail para confirmar seu cadastro.';

const GENERIC_FAILURE_MESSAGE = 'Não foi possível concluir o cadastro agora. Tente novamente mais tarde.';

/** Props for {@link RegisterForm}. */
export interface RegisterFormProps {
  /** Called after a successful submission, e.g. to return to the sign-in view. */
  readonly onSubmitted?: () => void;
}

/**
 * Account sign-up form bound to `POST /api/auth/register`.
 *
 * The route is the authority on every outcome; this component only renders what
 * the route returned. It deliberately has no "e-mail already in use" branch,
 * because distinguishing that case would allow account enumeration.
 *
 * @param props - Optional callback fired once a submission is accepted.
 * @returns The rendered sign-up form.
 */
export function RegisterForm({ onSubmitted }: RegisterFormProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<RegisterFeedback>({ _tag: 'Idle' });

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setFeedback({ _tag: 'Idle' });

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password }),
      });
      const payload: unknown = await response.json().catch(() => null);
      const message = typeof payload === 'object' && payload !== null && 'message' in payload
        && typeof (payload as { message: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : null;
      const error = typeof payload === 'object' && payload !== null && 'error' in payload
        && typeof (payload as { error: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : null;

      if (!response.ok) {
        setFeedback({ _tag: 'Rejected', message: error ?? GENERIC_FAILURE_MESSAGE });
        return;
      }

      setFeedback({ _tag: 'Submitted', message: message ?? FALLBACK_SUBMITTED_MESSAGE });
      setName('');
      setEmail('');
      setPassword('');
      onSubmitted?.();
    } catch {
      setFeedback({ _tag: 'Rejected', message: GENERIC_FAILURE_MESSAGE });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col"
      style={{ gap: 14 }}
      aria-describedby="register-feedback"
    >
      <div className="flex flex-col" style={{ gap: 5 }}>
        <label className="orbita-eyebrow" htmlFor="register-name">Nome</label>
        <input
          id="register-name"
          name="name"
          type="text"
          autoComplete="name"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Como devemos te chamar"
          className="orbita-campo"
        />
      </div>

      <div className="flex flex-col" style={{ gap: 5 }}>
        <label className="orbita-eyebrow" htmlFor="register-email">E-mail</label>
        <input
          id="register-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@empresa.com"
          className="orbita-campo"
        />
      </div>

      <div className="flex flex-col" style={{ gap: 5 }}>
        <label className="orbita-eyebrow" htmlFor="register-password">Senha</label>
        <input
          id="register-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Mínimo de 6 caracteres"
          aria-describedby="register-password-hint"
          className="orbita-campo"
        />
        <p id="register-password-hint" className="m-0 text-[11px]" style={{ color: 'var(--txt3)' }}>
          Use ao menos 6 caracteres.
        </p>
      </div>

      <output id="register-feedback" aria-live="polite" className="block min-h-[1.25rem]">
        {feedback._tag !== 'Idle' && (
          <span
            className="text-xs font-semibold"
            style={{ color: feedback._tag === 'Submitted' ? 'var(--accent)' : 'var(--danger)' }}
          >
            {feedback.message}
          </span>
        )}
      </output>

      <button
        id="btn-register-submit"
        type="submit"
        disabled={submitting}
        className="orbita-chip cursor-pointer justify-center w-full"
        style={{
          height: 'var(--h-field)',
          background: 'var(--accent)',
          borderColor: 'var(--accent)',
          color: 'var(--accent-fg)',
          fontSize: 13,
        }}
      >
        {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
        {submitting ? 'Criando…' : 'Criar conta'}
      </button>
    </form>
  );
}
