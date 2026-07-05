import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, Input, Logo } from '../components/ui/index.ts';
import { login, me } from '../lib/api.ts';
import { color } from '../theme.ts';

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Nice-to-have: if already signed in, skip the form. Doesn't block
  // rendering the form while the check is in flight.
  useEffect(() => {
    let cancelled = false;
    me()
      .then(() => {
        if (!cancelled) navigate('/dashboard', { replace: true });
      })
      .catch(() => {
        // Not signed in - stay on the login form.
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/dashboard', { replace: true });
    } catch {
      // Generic message - never reveals which field was wrong, matching the API.
      setError('Invalid email or password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100%',
        background: color.canvas,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '40px 20px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 22 }}>
          <Link to="/" style={{ textDecoration: 'none' }} aria-label="Clearbook home">
            <Logo markSize={34} />
          </Link>
        </div>
        <Card padding={26}>
          <h1
            style={{
              fontSize: 19,
              fontWeight: 700,
              letterSpacing: '-0.01em',
              color: color.text,
              margin: '0 0 4px',
              textAlign: 'center',
            }}
          >
            Sign in
          </h1>
          <p
            style={{
              fontSize: 13,
              color: color.textMuted,
              margin: '0 0 22px',
              textAlign: 'center',
            }}
          >
            Welcome back. Enter your credentials to continue.
          </p>
          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <Input
              label="Email"
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              label="Password"
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error ? (
              <div
                role="alert"
                style={{
                  fontSize: 12.5,
                  fontWeight: 500,
                  color: color.statusDangerTextStrong,
                  background: color.statusDangerBg,
                  border: `1px solid ${color.statusDangerBorder}`,
                  borderRadius: 8,
                  padding: '9px 12px',
                }}
              >
                {error}
              </div>
            ) : null}
            <Button type="submit" variant="primary" fullWidth height={42} disabled={submitting}>
              {submitting ? 'Signing in...' : 'Sign in'}
            </Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
