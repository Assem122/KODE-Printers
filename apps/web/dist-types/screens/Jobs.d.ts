import type { ReactElement } from 'react';
/**
 * Job history.
 *
 * Infinite scroll over keyset pages — §B5.4 forbids offset pagination, and the
 * cursor the server returns is threaded straight back, so scrolling to the
 * bottom of a year of history stays an index seek rather than a table walk.
 *
 * Walk-up rows are labelled honestly. A job with `jobType: 'unknown'` came from
 * a device with no vendor counter, where a print and a photocopy are
 * indistinguishable — DEC-06 settles that these are "device activity", not
 * prints, and the row says so rather than leaving the reader to assume.
 */
export declare function Jobs(): ReactElement;
//# sourceMappingURL=Jobs.d.ts.map
