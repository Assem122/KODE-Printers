/**
 * Object identifiers used against printers.
 *
 * Named constants rather than literals at the call sites: `1.3.6.1.2.1.43.5.1.1.17.1`
 * appearing in three files is three chances to transpose a digit, and a
 * transposed OID returns "no such object" rather than a wrong number, so it
 * fails as a silent gap in the audit trail rather than as an error.
 */

/* ------------------------------------------------------- RFC 1213, system  */

export const SYSTEM = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  sysLocation: '1.3.6.1.2.1.1.6.0',
} as const;

/* ---------------------------------------------- RFC 3805, the Printer-MIB  */

export const PRINTER_MIB = {
  /**
   * prtGeneralSerialNumber — the identity anchor (ADR-006).
   *
   * An IP address is a lease; a serial number is the device. Anchoring on the
   * former means a DHCP renewal silently turns a working printer into an
   * unreachable one, and the admin's natural fix — re-adding it — splits the
   * audit trail across two records with the permissions on the wrong one.
   */
  serialNumber: '1.3.6.1.2.1.43.5.1.1.17.1',

  /**
   * prtMarkerLifeCount — lifetime impressions.
   *
   * This counts *everything the print engine marks*: prints, photocopies,
   * received faxes and internally generated report pages. §A7.1 is blunt about
   * the consequence — on an MFP fleet in a sports club, where reception copies
   * membership forms all day, treating this delta as "prints" materially
   * overstates printing. Hence `walkupReportLabel` and the vendor OIDs below.
   */
  markerLifeCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',

  markerColorantValue: '1.3.6.1.2.1.43.11.1.1.6',
  /** prtMarkerSuppliesDescription — walked to enumerate cartridges. */
  suppliesDescription: '1.3.6.1.2.1.43.11.1.1.6.1',
  /** prtMarkerSuppliesLevel — current level; -2 means "unknown", -3 "some left". */
  suppliesLevel: '1.3.6.1.2.1.43.11.1.1.9.1',
  /** prtMarkerSuppliesMaxCapacity — denominator for the percentage. */
  suppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8.1',
  suppliesType: '1.3.6.1.2.1.43.11.1.1.5.1',
} as const;

/* ------------------------------------------- RFC 2790, host resources MIB  */

export const HOST_RESOURCES = {
  deviceDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
  /**
   * hrPrinterDetectedErrorState — a bit field, used where IPP is absent.
   *
   * Bit order is defined by the MIB and is *big-endian within each octet*, which
   * is the detail most implementations get wrong. See `ERROR_STATE_BITS`.
   */
  printerDetectedErrorState: '1.3.6.1.2.1.25.3.5.1.2.1',
  printerStatus: '1.3.6.1.2.1.25.3.5.1.1.1',
} as const;

/**
 * hrPrinterDetectedErrorState bit assignments (RFC 2790 §2).
 *
 * Bit 0 is the most significant bit of the first octet. Reading these as
 * little-endian produces a plausible-looking but entirely wrong state — "low
 * paper" reported as "service requested" — which is exactly the class of defect
 * that makes an operator stop trusting the dashboard.
 */
export const ERROR_STATE_BITS: ReadonlyArray<{ bit: number; reason: string }> = [
  { bit: 0, reason: 'media-low' },
  { bit: 1, reason: 'media-empty' },
  { bit: 2, reason: 'output-area-almost-full' },
  { bit: 3, reason: 'output-area-full' },
  { bit: 4, reason: 'marker-supply-low' },
  { bit: 5, reason: 'marker-supply-empty' },
  { bit: 6, reason: 'output-media-low' },
  { bit: 7, reason: 'output-media-empty' },
  { bit: 8, reason: 'media-jam' },
  { bit: 9, reason: 'paused' },
  { bit: 10, reason: 'door-open' },
  { bit: 11, reason: 'service-request' },
  { bit: 12, reason: 'input-tray-missing' },
  { bit: 13, reason: 'output-tray-missing' },
  { bit: 14, reason: 'marker-supply-missing' },
  { bit: 15, reason: 'offline' },
];

/**
 * Decodes the bit field into IPP-style reason keywords, so the rest of the
 * system has one vocabulary for device state regardless of which protocol
 * reported it.
 */
export function decodeErrorState(octets: Buffer): string[] {
  const reasons: string[] = [];
  for (const { bit, reason } of ERROR_STATE_BITS) {
    const byteIndex = Math.floor(bit / 8);
    const byte = octets[byteIndex];
    if (byte === undefined) continue;
    // Bit 0 is the MSB of octet 0.
    const mask = 0x80 >> (bit % 8);
    if ((byte & mask) !== 0) reasons.push(reason);
  }
  return reasons;
}

/**
 * Vendor-private counters that separate prints from photocopies (§B8.4, GAP-08).
 *
 * There is no standard equivalent — each manufacturer exposes its own tree,
 * which is why these are stored per printer in `snmp_print_oid` and
 * `snmp_copy_oid` rather than assumed. The values below are the defaults the
 * inventory pass (§B19.2) starts from; a device that answers none of them gets
 * `job_type = 'unknown'` and its activity is labelled, never counted as prints.
 */
export const VENDOR_COUNTERS: Readonly<
  Record<string, { print: string; copy: string; label: string }>
> = {
  hp: {
    print: '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.5.0',
    copy: '1.3.6.1.4.1.11.2.3.9.4.2.1.4.1.2.7.0',
    label: 'HP',
  },
  xerox: {
    print: '1.3.6.1.4.1.253.8.53.13.2.1.6.1.20.1',
    copy: '1.3.6.1.4.1.253.8.53.13.2.1.6.1.20.2',
    label: 'Xerox',
  },
  canon: {
    print: '1.3.6.1.4.1.1602.1.11.1.3.1.4.101',
    copy: '1.3.6.1.4.1.1602.1.11.1.3.1.4.102',
    label: 'Canon',
  },
  konica: {
    print: '1.3.6.1.4.1.18334.1.1.1.5.7.2.2.1.5.1.2',
    copy: '1.3.6.1.4.1.18334.1.1.1.5.7.2.2.1.5.2.2',
    label: 'Konica Minolta',
  },
  brother: {
    print: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.8.0',
    copy: '1.3.6.1.4.1.2435.2.3.9.4.2.1.5.5.9.0',
    label: 'Brother',
  },
};

/** Guesses the vendor family from an SNMP sysDescr or IPP make-and-model string. */
export function vendorKeyFrom(description: string): keyof typeof VENDOR_COUNTERS | null {
  const lower = description.toLowerCase();
  if (lower.includes('hewlett') || /\bhp\b/.test(lower)) return 'hp';
  if (lower.includes('xerox')) return 'xerox';
  if (lower.includes('canon')) return 'canon';
  if (lower.includes('konica') || lower.includes('minolta')) return 'konica';
  if (lower.includes('brother')) return 'brother';
  return null;
}
