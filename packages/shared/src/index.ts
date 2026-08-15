/**
 * @kode/shared — the contract between the KODE Printer server, the web client
 * and the site collector.
 *
 * Nothing in this package performs I/O or reads configuration. It is types,
 * validators and pure functions, so it can be imported into a browser bundle
 * and a Node process without either pulling in the other's dependencies.
 */

export * from './brand.js';
export * from './constants.js';
export * from './errors.js';
export * from './schemas.js';
export * from './types.js';
export * from './util.js';
