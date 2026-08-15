/**
 * KODE brand tokens, sampled directly from the marks in `kodeBranding/`.
 *
 * Kept in the shared package rather than in the web app because the server also
 * renders brand-coloured artefacts: QR sheets for printers, PDF report covers
 * and the HTML email templates. One palette, three renderers.
 */

/** Sampled from `images (2).png` and `images.jpg` — the primary logo lock-up. */
export const KODE_BLUE = '#2150A0';
/** Sampled from `images.jpg` — the inner counter of the K. */
export const KODE_GOLD = '#FEC015';

export const BRAND_COLORS = {
  /** The blue. Every primary action, the logo, the focused state. */
  blue: {
    50: '#EEF3FB',
    100: '#D8E4F6',
    200: '#B0C7EC',
    300: '#83A6E0',
    400: '#5482CE',
    500: '#2150A0',
    600: '#1C4489',
    700: '#173770',
    800: '#122B58',
    900: '#0D1F3F',
    950: '#08142A',
  },
  /** The gold. Used sparingly — accents, highlights, the "live" pulse. */
  gold: {
    50: '#FFF9E8',
    100: '#FFF0C4',
    200: '#FEE28B',
    300: '#FED253',
    400: '#FEC015',
    500: '#E5A804',
    600: '#BC8703',
    700: '#8F6603',
    800: '#63470A',
    900: '#3D2C08',
  },
  /**
   * Campaign accents, sampled from `images (1).jpg`. These carry the club's
   * sport-poster energy into data visualisation without diluting the primary
   * pair, and they are what stop the charts looking like every other dashboard.
   */
  accent: {
    orange: '#F26202',
    green: '#059969',
    electric: '#0267F7',
    navy: '#02327A',
    violet: '#5B3DF5',
    crimson: '#D32F4B',
  },
  /** Cool-shifted neutrals so greys sit under the blue rather than beside it. */
  ink: {
    0: '#FFFFFF',
    25: '#FBFCFE',
    50: '#F5F7FA',
    100: '#EBEEF4',
    200: '#DBE0EA',
    300: '#BEC6D6',
    400: '#8E99AF',
    500: '#68738C',
    600: '#4C566D',
    700: '#3A4256',
    800: '#242B3A',
    900: '#161B26',
    950: '#0B0E16',
  },
} as const;

/** Status colours. Chosen for AA contrast on both surfaces, not for prettiness. */
export const STATUS_COLORS = {
  online: BRAND_COLORS.accent.green,
  degraded: BRAND_COLORS.gold[400],
  offline: BRAND_COLORS.accent.crimson,
  unknown: BRAND_COLORS.ink[400],
} as const;

export const SEVERITY_COLORS = {
  info: BRAND_COLORS.blue[500],
  warning: BRAND_COLORS.gold[500],
  critical: BRAND_COLORS.accent.crimson,
} as const;

/**
 * Montserrat throughout, per the brand. The tabular variant matters: page
 * counts and impression figures sit in columns and must not shimmer as they
 * update on the live dashboard.
 */
export const TYPOGRAPHY = {
  fontFamily: "'Montserrat', 'Montserrat Fallback', system-ui, sans-serif",
  fontFamilyMono: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  weights: { regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 },
} as const;

/**
 * The K-mark's geometry, reused as a layout motif: the logo's diagonal is a
 * 26.5° cut, and echoing it in section dividers and card corners is what makes
 * the interface read as KODE rather than as a generic admin theme.
 */
export const BRAND_GEOMETRY = {
  diagonalDegrees: 26.5,
  /** The inline stroke inside the K, expressed as a border width in px. */
  inlineStroke: 2,
  radius: { sm: '6px', md: '10px', lg: '16px', xl: '24px', pill: '999px' },
} as const;

/* ────────────────────────────────────────────────────────────────── the mark */

export const KODE_MARK_VIEWBOX = '0 0 100 102';

/**
 * The KODE K, as vector path data.
 *
 * Traced from `kodeBranding/images (3).png`, the highest-resolution asset, at a
 * 1.3px tolerance on a 350px-wide glyph — under half a percent, which keeps the
 * 26.5° cut straight while dropping the bitmap's stair-stepping. 111 points
 * across six contours.
 *
 * The branding PDFs were the obvious source and turned out to contain only the
 * "KODE" wordmark; the mark itself exists solely as raster in the supplied
 * assets. If a true vector ever surfaces, replacing this constant is the whole
 * migration — every surface reads it from here.
 *
 * Six contours, and the count is the point: the mark is **two disjoint glyphs**
 * — the V above and the angled leg below — each drawn as a filled outline with
 * a hairline inner channel. So per glyph: the outline's outer edge, the
 * channel, and the inner fill.
 *
 * `fill-rule="evenodd"` is therefore mandatory. Under the default nonzero rule
 * the channel fills in and the mark becomes a solid blob.
 */
export const KODE_MARK_PATH =
  'M0 0 L25.93 0 L27.92.57 L30.48 1.99 L33.33 5.13 L34.47 7.41 L35.04 11.97 ' +
  'L43.3 2.85 L46.72.85 L49.86 0 L85.75 0 L85.75 5.7 L54.13 44.44 L51.28 46.72 ' +
  'L46.44 48.43 L11.11 48.43 L7.98 47.58 L4.56 45.58 L1.71 42.17 L.28 38.75 L0 .28Z ' +
  'M8.83 8.26 L25.36 8.26 L26.78 9.4 L27.07 29.91 L28.77 31.91 L30.2 31.62 ' +
  'L31.62 30.2 L49.29 9.12 L51.28 8.26 L73.5 8.26 L49.57 37.61 L47.58 39.6 ' +
  'L46.15 40.17 L12.25 40.17 L10.83 39.6 L8.83 37.04 L8.83 8.55Z ' +
  'M10.26 53.56 L47.29 53.56 L51.57 55.27 L54.99 58.4 L90.31 101.99 L49.29 101.71 ' +
  'L44.44 99.72 L42.17 98.01 L35.33 89.74 L34.76 90.03 L34.76 93.45 L33.62 96.3 ' +
  'L31.05 99.43 L28.21 101.14 L23.93 101.99 L.28 101.99 L.28 62.96 L1.71 59.54 ' +
  'L3.7 56.98 L7.41 54.42 L9.97 53.85Z ' +
  'M12.82 61.54 L45.58 61.54 L47.86 62.39 L73.22 93.45 L50.71 93.45 L49 92.59 ' +
  'L29.91 70.09 L27.92 70.37 L27.07 71.79 L26.78 92.31 L25.64 93.45 L8.83 93.45 ' +
  'L8.83 64.96 L10.54 62.39 L12.54 61.82Z ' +
  'M3.42 3.42 L25.64 3.42 L28.21 4.56 L30.48 6.84 L31.62 9.97 L31.91 21.65 ' +
  'L43.02 7.98 L45.58 5.41 L48.15 3.99 L50.14 3.42 L83.19 3.42 L51.85 41.88 ' +
  'L49.86 43.59 L46.15 45.01 L11.4 45.01 L6.84 43.02 L4.27 39.89 L3.42 37.32 L3.42 3.7Z ' +
  'M10.54 56.98 L47.01 56.98 L49.29 57.83 L52.71 60.97 L83.19 98.58 L51.28 98.58 ' +
  'L47.86 97.72 L43.59 94.59 L31.91 80.34 L31.62 91.74 L30.48 94.87 L27.92 97.44 ' +
  'L24.5 98.58 L3.42 98.58 L3.42 64.67 L5.7 59.83 L8.26 57.83 L10.26 57.26Z';

/** Aspect ratio of the mark, for sizing without hard-coding both dimensions. */
export const KODE_MARK_ASPECT = 100 / 102;
