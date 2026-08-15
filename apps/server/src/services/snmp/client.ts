import snmp from 'net-snmp';
import { config } from '../../config/index.js';
import { subsystem } from '../../utilities/logger.js';
import type { PrinterWithSecrets } from '../../models/printers.js';

const log = subsystem('snmp');

/**
 * SNMP access, built on a maintained library (ADR-005, GAP-26).
 *
 * The delivered build hand-wrote a BER/ASN.1 encoder to avoid a dependency.
 * That trade does not survive one observation: the avoided dependency is a
 * binary parser consuming *unauthenticated UDP from the network*, which makes
 * it the least-reviewed security-relevant code in the system — and it cannot do
 * SNMPv3 at all. Replacing it is a security fix, not a refactor.
 *
 * The OID and polling logic ported across unchanged; only the wire layer moved.
 */

export interface SnmpValue {
  oid: string;
  value: string | number | Buffer | null;
}

export class SnmpUnavailableError extends Error {
  constructor(host: string, cause?: unknown) {
    super(`SNMP did not answer at ${host}`, cause === undefined ? undefined : { cause });
    this.name = 'SnmpUnavailableError';
  }
}

type Session = {
  get(oids: string[], callback: (error: Error | null, varbinds: VarBind[]) => void): void;
  subtree?(
    oid: string,
    feedCallback: (varbinds: VarBind[]) => void,
    doneCallback: (error: Error | null) => void,
  ): void;
  close(): void;
  on(event: string, listener: (error: Error) => void): void;
};

interface VarBind {
  oid: string;
  type: number;
  value: unknown;
}

/**
 * Opens a session configured for the printer's SNMP version.
 *
 * Transport policy per §B8.1: prefer v2c (GetBulk, better error reporting),
 * support v3 with authPriv where the fleet allows it, retain v1 for devices
 * that support nothing else.
 */
function openSession(printer: PrinterWithSecrets): Session {
  const common = {
    port: 161,
    retries: config.snmp.retries,
    timeout: config.snmp.timeoutMs,
    transport: 'udp4' as const,
    idBitsSize: 32,
  };

  if (printer.snmpVersion === '3') {
    const user = {
      name: printer.snmpUsername ?? '',
      level:
        printer.snmpAuthKey && printer.snmpPrivKey
          ? snmp.SecurityLevel.authPriv
          : printer.snmpAuthKey
            ? snmp.SecurityLevel.authNoPriv
            : snmp.SecurityLevel.noAuthNoPriv,
      authProtocol: snmp.AuthProtocols.sha,
      authKey: printer.snmpAuthKey ?? '',
      privProtocol: snmp.PrivProtocols.aes,
      privKey: printer.snmpPrivKey ?? '',
    };
    return snmp.createV3Session(printer.ipAddress, user, common);
  }

  const version = printer.snmpVersion === '1' ? snmp.Version1 : snmp.Version2c;
  const community = printer.snmpCommunity ?? config.snmp.defaultCommunity;
  return snmp.createSession(printer.ipAddress, community, {
    ...common,
    version,
  });
}

/**
 * Reads a set of OIDs in one request.
 *
 * Missing objects come back as `null` rather than throwing. That distinction
 * carries weight: "this device does not implement a serial-number OID" is a
 * fact to record in the inventory, whereas "this device did not answer at all"
 * is a reachability failure that should raise the failure counter. Collapsing
 * both into an exception loses the difference.
 */
export async function snmpGet(
  printer: PrinterWithSecrets,
  oids: readonly string[],
): Promise<Map<string, SnmpValue['value']>> {
  if (printer.snmpVersion === 'disabled' || oids.length === 0) return new Map();

  return new Promise((resolve, reject) => {
    let session: Session;
    try {
      session = openSession(printer);
    } catch (error) {
      reject(new SnmpUnavailableError(printer.ipAddress, error));
      return;
    }

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        session.close();
      } catch {
        // A close error after we already have our answer is not interesting.
      }
      fn();
    };

    // The library surfaces socket errors on the session rather than the
    // callback; without this an unreachable host leaves the promise pending.
    session.on('error', (error) =>
      finish(() => reject(new SnmpUnavailableError(printer.ipAddress, error))),
    );

    session.get([...oids], (error, varbinds) => {
      if (error) {
        finish(() => reject(new SnmpUnavailableError(printer.ipAddress, error)));
        return;
      }

      const result = new Map<string, SnmpValue['value']>();
      for (const varbind of varbinds) {
        if (snmp.isVarbindError(varbind)) {
          result.set(varbind.oid, null);
          continue;
        }
        result.set(varbind.oid, normalise(varbind.value));
      }
      finish(() => resolve(result));
    });
  });
}

/** Walks a subtree — used to enumerate supply cartridges, whose count varies. */
export async function snmpWalk(
  printer: PrinterWithSecrets,
  rootOid: string,
  maxEntries = 32,
): Promise<SnmpValue[]> {
  if (printer.snmpVersion === 'disabled') return [];

  return new Promise((resolve, reject) => {
    let session: Session;
    try {
      session = openSession(printer);
    } catch (error) {
      reject(new SnmpUnavailableError(printer.ipAddress, error));
      return;
    }

    const collected: SnmpValue[] = [];
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      try {
        session.close();
      } catch {
        /* see snmpGet */
      }
      fn();
    };

    session.on('error', (error) =>
      finish(() => reject(new SnmpUnavailableError(printer.ipAddress, error))),
    );

    if (typeof session.subtree !== 'function') {
      finish(() => resolve([]));
      return;
    }

    session.subtree(
      rootOid,
      (varbinds) => {
        for (const varbind of varbinds) {
          if (collected.length >= maxEntries) return;
          if (snmp.isVarbindError(varbind)) continue;
          collected.push({ oid: varbind.oid, value: normalise(varbind.value) });
        }
      },
      (error) => {
        // A partial walk is still useful: three of four cartridges read is
        // better than none, so collected values are returned rather than
        // discarded when the walk is cut short.
        if (error && collected.length === 0) {
          finish(() => reject(new SnmpUnavailableError(printer.ipAddress, error)));
          return;
        }
        finish(() => resolve(collected));
      },
    );
  });
}

/**
 * §B8.6 — replies are accepted only from the address that was queried.
 *
 * UDP has no sender authentication, so without this a host on the same segment
 * could inject a fabricated counter delta and manufacture walk-up entries. The
 * library binds its socket per session and matches the source, so this function
 * documents and asserts the property rather than implementing it; SNMPv3 with
 * authPriv is the real fix where the fleet supports it.
 */
export function transportIsAuthenticated(printer: PrinterWithSecrets): boolean {
  return printer.snmpVersion === '3' && Boolean(printer.snmpAuthKey);
}

function normalise(value: unknown): SnmpValue['value'] {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Anything else is a shape the library does not document. JSON keeps the
  // surprise visible rather than collapsing it to "[object Object]".
  return JSON.stringify(value) ?? null;
}

/** Reads a varbind as an integer, tolerating the string forms devices return. */
export function asInteger(value: SnmpValue['value']): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Buffer.isBuffer(value)) {
    const parsed = Number.parseInt(value.toString('ascii').trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Reads a varbind as text.
 *
 * Serial numbers and descriptions arrive as OCTET STRING, which some firmware
 * pads with NULs and some encodes as UTF-16. Trimming both is what stops a
 * serial number comparing unequal to itself between two polls — which would
 * fire a false "printer replaced" alert.
 */
export function asString(value: SnmpValue['value']): string | null {
  if (value === null) return null;
  const raw = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      : String(value);
  // eslint-disable-next-line no-control-regex -- firmware pads with NULs
  const cleaned = raw.replace(/\u0000/g, '').trim();
  return cleaned === '' ? null : cleaned;
}

export function logSnmpFailure(printer: PrinterWithSecrets, error: unknown): void {
  // Community strings are never logged. INV-08.
  log.debug(
    { printerId: printer.id, host: printer.ipAddress, version: printer.snmpVersion },
    error instanceof Error ? `SNMP failed: ${error.message}` : 'SNMP failed',
  );
}
