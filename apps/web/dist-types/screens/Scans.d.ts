import type { ReactElement } from 'react';
/**
 * The scan hub.
 *
 * §B9 describes detection only — a watcher observes a folder and logs what
 * arrives. This screen is what makes that useful to a person: an inbox where a
 * scan is previewed in place, claimed, and downloaded.
 *
 * The design problem is ownership. A file dropped into an SMB share by printer
 * firmware carries no identity, so scans start unclaimed and visible to anyone
 * permitted to use that device — which mirrors the physical reality of paper
 * sitting in an output tray. Scan-to-me is the fix: reserve the printer before
 * walking over, and the next arrival is filed to you automatically.
 */
export declare function Scans(): ReactElement;
//# sourceMappingURL=Scans.d.ts.map
