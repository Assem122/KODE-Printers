import nodemailer, { type Transporter } from 'nodemailer';
import webpush from 'web-push';
import type { Severity } from '@kode/shared';
import { config } from '../config/index.js';
import { pool, type Db } from '../db/pool.js';
import { notificationsModel, type NotificationWrite } from '../models/notifications.js';
import { getSettings } from '../models/settings.js';
import { serialiseError, subsystem } from '../utilities/logger.js';
import { events } from './events.js';

const log = subsystem('notify');

/**
 * Notification fan-out: database, live stream, Web Push, email.
 *
 * The ordering is a policy, not an accident. The database write happens first
 * and is the only step allowed to fail loudly; the three delivery channels are
 * best-effort and never propagate an error to the caller.
 *
 * The reason is that notification delivery must never take down the thing it is
 * notifying about. A dead SMTP relay should not fail a print job, and a browser
 * with a stale push subscription should not roll back a printer status update.
 * The record is in Postgres either way, so nothing is lost — it is seen a
 * moment later instead of instantly.
 */

let mailer: Transporter | null = null;
let pushConfigured = false;

export function initialiseChannels(): void {
  if (config.email.enabled && config.email.host) {
    mailer = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      // An internal relay usually accepts unauthenticated mail from known
      // hosts; credentials are supplied only if the club's relay wants them.
      ...(config.email.user && config.email.password
        ? { auth: { user: config.email.user, pass: config.email.password } }
        : {}),
      pool: true,
      maxConnections: 2,
      connectionTimeout: 10_000,
    });
    log.info({ host: config.email.host, port: config.email.port }, 'SMTP channel ready');
  }

  if (config.push.enabled && config.push.publicKey && config.push.privateKey) {
    webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
    pushConfigured = true;
    log.info('Web Push channel ready');
  }
}

export interface NotifyInput extends NotificationWrite {
  /** Also send to the browser as a push notification. */
  push?: boolean;
  /** Also send by email, where an address is on file. */
  email?: boolean;
}

/**
 * Records a notification and fans it out.
 *
 * `dedupeKey` collapses repeats — a printer polled every fifteen seconds while
 * offline produces one row whose `occurrences` climbs, not 240 rows. Without it
 * the notification centre becomes unusable within an hour of any outage, which
 * is precisely when it matters most.
 */
export async function notify(input: NotifyInput, db: Db = pool): Promise<void> {
  const notification = await notificationsModel.create(db, input);
  if (!notification) return;

  events.notificationCreated(notification, input.userId ?? null);

  const settings = await getSettings(db).catch(() => null);

  if (input.push && settings?.webPushEnabled) {
    void sendPush(input.userId ?? null, notification.message, input.severity, db).catch(
      (error: unknown) => log.warn({ ...serialiseError(error) }, 'push delivery failed'),
    );
  }

  if (input.email && settings?.emailEnabled) {
    void sendEmail(input.userId ?? null, notification.message, input.severity, db).catch(
      (error: unknown) => log.warn({ ...serialiseError(error) }, 'email delivery failed'),
    );
  }
}

/** Clears a dedupe key so the next occurrence raises a fresh alert. */
export async function resolveCondition(dedupeKey: string, db: Db = pool): Promise<void> {
  await notificationsModel.resolveDedupeKey(db, dedupeKey);
}

/* ------------------------------------------------------------- web push    */

export async function savePushSubscription(
  db: Db,
  userId: number,
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  userAgent: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint)
     DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh,
                   auth = EXCLUDED.auth, last_used_at = now()`,
    [userId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent],
  );
}

async function sendPush(
  userId: number | null,
  message: string,
  severity: Severity,
  db: Db,
): Promise<void> {
  if (!pushConfigured) return;

  const { rows } = await db.query<{
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
  }>(
    userId === null
      ? `SELECT s.id, s.endpoint, s.p256dh, s.auth
           FROM push_subscriptions s
           JOIN users u ON u.id = s.user_id
          WHERE u.role = 'admin' AND u.is_active`
      : `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    userId === null ? [] : [userId],
  );

  const payload = JSON.stringify({
    title: severity === 'critical' ? 'KODE Printer — action needed' : 'KODE Printer',
    body: message,
    severity,
  });

  await Promise.all(
    rows.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
        );
      } catch (error) {
        // 404 and 410 mean the browser discarded the subscription — the user
        // cleared site data or uninstalled the PWA. Deleting it here is what
        // stops the table filling with endpoints that can never be delivered.
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.query('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
        } else {
          log.debug({ ...serialiseError(error) }, 'push send failed');
        }
      }
    }),
  );
}

/* ---------------------------------------------------------------- email    */

const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  info: 'Notice',
  warning: 'Warning',
  critical: 'Action needed',
};

async function sendEmail(
  userId: number | null,
  message: string,
  severity: Severity,
  db: Db,
): Promise<void> {
  if (!mailer) return;

  const { rows } = await db.query<{ email: string }>(
    userId === null
      ? `SELECT email::text AS email FROM users
          WHERE role = 'admin' AND is_active AND email IS NOT NULL`
      : `SELECT email::text AS email FROM users WHERE id = $1 AND email IS NOT NULL`,
    userId === null ? [] : [userId],
  );

  const recipients = rows.map((row) => row.email).filter(Boolean);
  if (recipients.length === 0) return;

  await mailer.sendMail({
    from: config.email.from,
    // BCC, not To: an operational alert should not disclose the admin roster to
    // every recipient.
    bcc: recipients,
    subject: `KODE Printer — ${SEVERITY_LABEL[severity]}`,
    text: `${message}\n\n— KODE Printer\n${config.http.publicUrl}`,
    html: renderEmail(message, severity),
  });
}

/**
 * Minimal branded HTML. Inline styles and a table layout, because that is what
 * Outlook renders correctly and Outlook is what the club uses.
 */
function renderEmail(message: string, severity: Severity): string {
  const accent =
    severity === 'critical' ? '#D32F4B' : severity === 'warning' ? '#E5A804' : '#2150A0';
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#F5F7FA;font-family:Montserrat,Segoe UI,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#FFFFFF;border-radius:12px;overflow:hidden;border:1px solid #DBE0EA;">
  <tr><td style="height:4px;background:${accent};"></td></tr>
  <tr><td style="padding:24px 28px;">
    <div style="font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#68738C;font-weight:700;">KODE Printer</div>
    <div style="margin-top:12px;font-size:15px;line-height:1.6;color:#242B3A;">${escaped}</div>
    <div style="margin-top:24px;">
      <a href="${config.http.publicUrl}" style="display:inline-block;background:${accent};color:#FFFFFF;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:700;">Open KODE Printer</a>
    </div>
  </td></tr>
  <tr><td style="padding:16px 28px;background:#F5F7FA;font-size:11px;color:#68738C;">
    KODE Sports Club · Technology. This message was sent automatically.
  </td></tr>
</table></body></html>`;
}

export async function verifyEmailChannel(): Promise<{ ok: boolean; detail?: string }> {
  if (!mailer) return { ok: false, detail: 'not configured' };
  try {
    await mailer.verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
