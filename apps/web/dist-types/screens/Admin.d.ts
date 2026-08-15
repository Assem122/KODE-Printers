import type { ReactElement } from 'react';
/**
 * Administration.
 *
 * Sub-routes rather than tabs holding local state, so a link to
 * `/admin/permissions` is shareable and the back button behaves. Everything
 * here is already gated server-side; the client gate in `App.tsx` exists so a
 * non-admin never sees a door they cannot open.
 */
export declare function Admin(): ReactElement;
//# sourceMappingURL=Admin.d.ts.map
