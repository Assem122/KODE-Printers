import type { ReactElement } from 'react';
import { useState, type FormEvent } from 'react';
import { motion } from 'framer-motion';
import { ApiError } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { Button, Field, Input, KodeMark, Switch } from '../components/ui.js';

/**
 * Sign-in.
 *
 * The panel on the left is not decoration for its own sake — a login screen is
 * the one surface every member of staff sees, and a bare centred form on a grey
 * page is where an internal tool starts feeling like an internal tool. The
 * diagonal echoes the K's shear, the mark is oversized and cropped, and the
 * whole panel collapses away below 900px so the phone experience is the form
 * and nothing else.
 */
export function SignIn(): ReactElement {
  const { signIn } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(username.trim(), password, rememberMe);
    } catch (caught) {
      // The server returns one message for every rejection path, so the form
      // cannot become a username oracle. It is repeated verbatim rather than
      // reinterpreted here.
      setError(
        caught instanceof ApiError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        minHeight: '100dvh',
      }}
      className="signin"
    >
      <style>{`
        @media (width >= 900px) {
          .signin { grid-template-columns: 1.1fr 1fr !important; }
          .signin__panel { display: grid !important; }
        }
      `}</style>

      {/* ── brand panel ─────────────────────────────────────────────────── */}
      <aside
        className="signin__panel"
        style={{
          display: 'none',
          position: 'relative',
          overflow: 'hidden',
          background: 'linear-gradient(150deg, var(--surface-2), var(--surface-base) 70%)',
          borderRight: '1px solid var(--border-subtle)',
          alignContent: 'center',
          padding: 'var(--space-8)',
        }}
      >
        {/* The mark, oversized and bled off the edge. Cropping it is what makes
            it read as a graphic rather than as a logo placed on a page. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            right: '-14%',
            top: '50%',
            translate: '0 -50%',
            color: 'var(--kode-blue)',
            opacity: 0.16,
            filter: 'blur(0.4px)',
          }}
        >
          <KodeMark size={460} />
        </div>

        {/* The diagonal sweep, at the mark's own 26.5°. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: '-20% -30%',
            background:
              'linear-gradient(to bottom, transparent 30%, rgb(254 192 21 / 8%) 50%, transparent 70%)',
            transform: 'rotate(var(--kode-angle))',
          }}
        />

        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ position: 'relative', maxWidth: '30rem' }}
        >
          <div className="kode-eyebrow">KODE Sports Club · Technology</div>
          <h1
            style={{
              marginTop: 'var(--space-4)',
              fontSize: 'clamp(2.4rem, 4vw, 3.4rem)',
              fontWeight: 900,
              letterSpacing: '-0.035em',
              lineHeight: 1.02,
            }}
          >
            Every page,
            <br />
            <span style={{ color: 'var(--kode-gold)' }}>accounted for.</span>
          </h1>
          <p
            style={{
              marginTop: 'var(--space-5)',
              fontSize: 'var(--text-lg)',
              color: 'var(--text-secondary)',
              maxWidth: '34ch',
            }}
          >
            Print from any browser, collect your scans, and see exactly what the club printed —
            without installing anything.
          </p>

          <ul
            style={{
              marginTop: 'var(--space-6)',
              display: 'grid',
              gap: 'var(--space-3)',
              listStyle: 'none',
              padding: 0,
              fontSize: 'var(--text-sm)',
              color: 'var(--text-secondary)',
            }}
          >
            {[
              'No drivers, no installs — it works from the browser',
              'Jobs are held, retried, and never silently lost',
              'Walk-up activity at the device is tracked too',
            ].map((line) => (
              <li key={line} className="row" style={{ gap: 'var(--space-3)' }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 5,
                    height: 5,
                    borderRadius: '50%',
                    background: 'var(--kode-gold)',
                    flexShrink: 0,
                  }}
                />
                {line}
              </li>
            ))}
          </ul>
        </motion.div>
      </aside>

      {/* ── form ────────────────────────────────────────────────────────── */}
      <main
        style={{
          display: 'grid',
          placeItems: 'center',
          padding: 'var(--space-5)',
        }}
      >
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
          style={{ width: 'min(400px, 100%)' }}
        >
          <div className="row" style={{ gap: 'var(--space-3)', marginBottom: 'var(--space-6)' }}>
            <span style={{ color: 'var(--kode-blue-bright)' }}>
              <KodeMark size={34} title="KODE" />
            </span>
            <div>
              <div
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 900,
                  fontSize: 'var(--text-xl)',
                  letterSpacing: '-0.025em',
                  lineHeight: 1.1,
                }}
              >
                KODE Printer
              </div>
              <div className="kode-eyebrow">Sign in to continue</div>
            </div>
          </div>

          <form
            onSubmit={(event) => {
              void onSubmit(event);
            }}
            className="stack"
            noValidate
          >
            <Field label="Username">
              {(id) => (
                <Input
                  id={id}
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  required
                  autoFocus
                  aria-invalid={Boolean(error)}
                />
              )}
            </Field>

            <Field label="Password">
              {(id) => (
                <Input
                  id={id}
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  required
                  aria-invalid={Boolean(error)}
                />
              )}
            </Field>

            <Switch
              checked={rememberMe}
              onChange={setRememberMe}
              label="Keep me signed in"
              hint="Only on a device that is yours."
            />

            {error ? (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="note note--critical"
                role="alert"
              >
                <span aria-hidden="true">⚠</span>
                <span>{error}</span>
              </motion.div>
            ) : null}

            <Button type="submit" variant="primary" size="lg" block loading={busy}>
              Sign in
            </Button>
          </form>

          <p
            className="dim"
            style={{ marginTop: 'var(--space-5)', fontSize: 'var(--text-xs)', textAlign: 'center' }}
          >
            Forgotten your password? An administrator can reset it for you.
          </p>
        </motion.div>
      </main>
    </div>
  );
}
