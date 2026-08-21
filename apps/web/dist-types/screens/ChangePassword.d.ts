import type { ReactElement } from 'react';
/**
 * Change password.
 *
 * When `forced`, this is the only reachable screen — GAP-01's client-side face.
 * The server is the actual control (every other route returns
 * PASSWORD_CHANGE_REQUIRED), and this exists so the user meets a form instead
 * of a wall of errors. There is deliberately no "skip" affordance: §B12.4 says
 * an operational reminder is not a control, and a dismissible prompt is exactly
 * that.
 */
export declare function ChangePassword({ forced }: {
    forced?: boolean;
}): ReactElement;
//# sourceMappingURL=ChangePassword.d.ts.map