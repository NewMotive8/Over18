import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type AuthCredentials } from '@over18/shared';
import { ApiRequestError } from '../lib/api';

interface AuthFormProps {
  mode: 'login' | 'register';
  onSubmit: (credentials: AuthCredentials) => Promise<void>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Shared login/register form: client-side validation, loading state,
 * API error display, and redirect after success (back to the page the
 * visitor was heading to, or /characters).
 */
export default function AuthForm({ mode, onSubmit }: AuthFormProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [apiError, setApiError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isRegister = mode === 'register';

  function validate(): boolean {
    const errors: { email?: string; password?: string } = {};
    if (!EMAIL_RE.test(email.trim())) {
      errors.email = 'Please enter a valid email address.';
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
    } else if (password.length > PASSWORD_MAX_LENGTH) {
      errors.password = `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setApiError(null);
    if (!validate()) return;
    setSubmitting(true);
    try {
      await onSubmit({ email: email.trim(), password });
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from ?? '/characters', { replace: true });
    } catch (err) {
      setApiError(err instanceof ApiRequestError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 ' +
    'placeholder-zinc-500 outline-none focus:border-rose-500';

  return (
    <section className="flex flex-col gap-6 py-8">
      <div className="text-center">
        <h2 className="text-2xl font-semibold">{isRegister ? 'Create account' : 'Log in'}</h2>
        <p className="mt-1 text-sm text-zinc-400">
          {isRegister ? 'Join Over18 to start chatting.' : 'Welcome back.'}
        </p>
      </div>

      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="email" className="text-xs font-medium text-zinc-400">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="you@example.com"
            disabled={submitting}
          />
          {fieldErrors.email && <p className="text-xs text-red-400">{fieldErrors.email}</p>}
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="password" className="text-xs font-medium text-zinc-400">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            placeholder={isRegister ? `At least ${PASSWORD_MIN_LENGTH} characters` : 'Your password'}
            disabled={submitting}
          />
          {fieldErrors.password && <p className="text-xs text-red-400">{fieldErrors.password}</p>}
        </div>

        {apiError && (
          <p role="alert" className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-sm text-red-300">
            {apiError}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-rose-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? (isRegister ? 'Creating account…' : 'Logging in…') : isRegister ? 'Create account' : 'Log in'}
        </button>
      </form>

      <p className="text-center text-sm text-zinc-400">
        {isRegister ? (
          <>
            Already have an account?{' '}
            <Link to="/login" className="text-rose-500 hover:underline">
              Log in
            </Link>
          </>
        ) : (
          <>
            New here?{' '}
            <Link to="/register" className="text-rose-500 hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>
    </section>
  );
}
