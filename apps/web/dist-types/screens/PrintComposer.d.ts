import type { ReactElement } from 'react';
/**
 * The print composer — the screen this system exists for.
 *
 * Three decisions shape it:
 *
 *   1. **The printer is chosen first, the file second.** Options depend on what
 *      the device can actually do, and offering duplex before knowing whether
 *      the printer supports it means either lying or re-rendering the form.
 *
 *   2. **Unverified options are disabled, not hidden.** §B7.3 is blunt: showing
 *      a duplex toggle that silently does nothing is worse than not showing it.
 *      So where the capability probe returned nothing, the control is disabled
 *      with an explanation rather than quietly absent — which also tells an
 *      admin that device needs a probe.
 *
 *   3. **The impression count is live and prominent.** It is the number the
 *      printer will actually mark, and seeing "312 pages" before pressing Print
 *      is what stops the whole staff handbook coming out of the reception
 *      printer.
 */
export declare function PrintComposer(): ReactElement;
//# sourceMappingURL=PrintComposer.d.ts.map