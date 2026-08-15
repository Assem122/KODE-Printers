/**
 * Ambient types for `net-snmp`, which ships none.
 *
 * ADR-005 replaced a hand-rolled BER/ASN.1 client with this library, and the
 * declaration below is the cost of that trade. It covers only what
 * `services/snmp/client.ts` actually calls — a deliberately narrow surface, so
 * reaching for anything else is a conscious decision rather than an accidental
 * `any`.
 */
declare module 'net-snmp' {
  export const Version1: number;
  export const Version2c: number;
  export const Version3: number;

  export const SecurityLevel: {
    noAuthNoPriv: number;
    authNoPriv: number;
    authPriv: number;
  };

  export const AuthProtocols: { md5: number; sha: number; sha224: number; sha256: number };
  export const PrivProtocols: { des: number; aes: number; aes256b: number; aes256r: number };

  export interface Varbind {
    oid: string;
    type: number;
    value: unknown;
  }

  export interface SessionOptions {
    port?: number;
    retries?: number;
    timeout?: number;
    transport?: 'udp4' | 'udp6';
    version?: number;
    idBitsSize?: number;
  }

  export interface V3User {
    name: string;
    level: number;
    authProtocol?: number;
    authKey?: string;
    privProtocol?: number;
    privKey?: string;
  }

  export interface Session {
    get(oids: string[], callback: (error: Error | null, varbinds: Varbind[]) => void): void;
    subtree(
      oid: string,
      feedCallback: (varbinds: Varbind[]) => void,
      doneCallback: (error: Error | null) => void,
    ): void;
    close(): void;
    on(event: string, listener: (error: Error) => void): void;
  }

  export function createSession(
    target: string,
    community: string,
    options?: SessionOptions,
  ): Session;

  export function createV3Session(target: string, user: V3User, options?: SessionOptions): Session;

  /**
   * True when a varbind carries an SNMP error rather than a value.
   *
   * The distinction matters: "this device does not implement that OID" is a
   * fact to record in the inventory, while "this device did not answer" is a
   * reachability failure that should raise the failure counter.
   */
  export function isVarbindError(varbind: Varbind): boolean;
  export function varbindError(varbind: Varbind): string;

  /** Used only by the fake-printer harness. */
  export function createAgent(
    options: { port?: number; disableAuthorization?: boolean },
    callback: (error: Error | null) => void,
  ): unknown;
}
