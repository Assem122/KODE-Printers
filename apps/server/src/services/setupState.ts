import { subsystem } from '../utilities/logger.js';

const log = subsystem('setup');

/**
 * Whether first-run setup is still outstanding (GAP-01).
 *
 * §B12.4 is right that an operational reminder is not a control: while an
 * account still holds the seeded password, the system must be unusable. The
 * question is what "unusable" should mean.
 *
 * Refusing to boot was the first answer and it is a trap. The seed creates the
 * administrator holding that password, and the only way to change it is a
 * request to a running server. Any restart in the window between seeding and
 * the first sign-in, a crash, a host reboot, `docker compose restart`, leaves a
 * system that cannot start and cannot be recovered without editing the database
 * by hand. The guard's own remedy, "sign in and change the password", is
 * impossible in the state the guard creates, and Compose restarts the container
 * automatically, so the likely shape is a crash loop.
 *
 * Booting into a locked state keeps the control and removes the trap. The
 * process starts, every route outside the sign-in and password-change path is
 * refused, and the operator can do the one thing that clears it.
 */

let incomplete = false;
let check: (() => Promise<boolean>) | null = null;

export function configureSetupState(
  checker: () => Promise<boolean>,
  initiallyIncomplete: boolean,
): void {
  check = checker;
  incomplete = initiallyIncomplete;
  if (incomplete) {
    log.error(
      'an account still holds the seeded password; the API is locked to sign-in and ' +
        'password change until it is changed',
    );
  }
}

export function isSetupIncomplete(): boolean {
  return incomplete;
}

/**
 * Re-runs the check, called after any password change.
 *
 * Pull rather than push: the auth service does not need to know what the
 * condition is, only that it may have just resolved it.
 */
export async function revalidateSetupState(): Promise<boolean> {
  if (!check || !incomplete) return incomplete;
  try {
    incomplete = await check();
    if (!incomplete) log.info('seeded password cleared; the API is now unlocked');
  } catch (error) {
    // A failed check must not unlock the system.
    log.error({ err: String(error) }, 'could not re-check the seeded password state');
  }
  return incomplete;
}

/** Test seam. */
export function resetSetupState(): void {
  incomplete = false;
  check = null;
}
