/**
 * Fixed error codes and messages of the spike probes.
 *
 * An error message at run time can carry data from the instance: a host
 * name, a path or a value from a response. The probes therefore never print
 * `message`, `cause` or a stack trace. They print one code from the list
 * below and, where it helps, one of the fixed hints.
 *
 * @packageDocumentation
 */

/** Every code a probe may report. */
export const errorCodes = [
  'KONFIGURATION',
  'DATEI',
  'NETZ_DNS',
  'NETZ_VERBINDUNG',
  'NETZ',
  'TLS',
  'TIMEOUT',
  'HTTP_REDIRECT',
  'ANTWORT_ZU_GROSS',
  'ANTWORT_UNGUELTIG',
  'INTERN',
] as const;

/** One of the fixed error codes. */
export type ErrorCode = (typeof errorCodes)[number];

/** Fixed hints in German, shown to the person who runs a probe. */
export const hints = {
  umgebungUnsicher:
    'Abbruch: Eine Variable ist gesetzt, die Node.js Code oder Zertifikate unterschiebt (NODE_OPTIONS, NODE_DEBUG, NODE_PATH, NODE_EXTRA_CA_CERTS oder NODE_TLS_REJECT_UNAUTHORIZED=0). Starten Sie die Probe wie im README beschrieben.',
  basisUrlFehlt: 'Abbruch: ECCLIUM_SPIKE_BASE_URL fehlt.',
  basisUrlUngueltig:
    'Abbruch: ECCLIUM_SPIKE_BASE_URL muss eine https-Adresse ohne Benutzer, Pfad, Query und Fragment sein.',
  tokenDateiFehlt: 'Abbruch: ECCLIUM_SPIKE_TOKEN_FILE fehlt.',
  tokenDateiNichtGefunden:
    'Abbruch: Die Token-Datei wurde nicht gefunden. Prüfen Sie den Pfad in ECCLIUM_SPIKE_TOKEN_FILE.',
  tokenDateiUnsicher:
    'Abbruch: Die Token-Datei muss eine reguläre Datei des aufrufenden Benutzers sein, ohne Rechte für andere, höchstens 4 KiB gross und ausserhalb eines Git-Arbeitsbaums.',
  tokenUngueltig:
    'Abbruch: Die Token-Datei muss genau eine Zeile aus druckbaren ASCII-Zeichen ohne Leerzeichen enthalten.',
  stateDateiFehlt: 'Abbruch: ECCLIUM_SPIKE_STATE_FILE fehlt.',
  stateDateiNichtGefunden:
    'Abbruch: Die State-Datei wurde nicht gefunden. Führen Sie zuerst 00-inventory aus.',
  stateDateiVorhanden:
    'Abbruch: Die State-Datei existiert schon. 00-inventory legt sie neu an. Löschen Sie sie, um die Probe zu wiederholen.',
  stateDateiUnsicher:
    'Abbruch: Die State-Datei muss eine reguläre Datei des aufrufenden Benutzers sein, ohne Rechte für andere und ausserhalb eines Git-Arbeitsbaums.',
  stateDateiUngueltig:
    'Abbruch: Die State-Datei ist beschädigt oder stammt nicht von 00-inventory. Führen Sie zuerst 00-inventory aus.',
  kategorieFehlt:
    'Abbruch: ECCLIUM_SPIKE_WIKI_CATEGORY_ID fehlt oder ist keine positive ganze Zahl.',
  gesperrteKategorieUngueltig:
    'Abbruch: ECCLIUM_SPIKE_FORBIDDEN_CATEGORY_ID ist keine positive ganze Zahl.',
  spezifikationUngueltig:
    'Abbruch: Die Instanz liefert unter dem erwarteten Pfad kein OpenAPI-Dokument.',
  netz: 'Abbruch: Die Instanz ist nicht erreichbar. Code siehe oben.',
  antwort:
    'Abbruch: Die Instanz hat eine Antwort geliefert, die die Probe nicht verarbeiten kann. Code siehe oben.',
  intern:
    'Abbruch: Unerwarteter Fehler in der Probe. Es wurde nichts aus der Antwort ausgegeben.',
} as const;

/** The key of one fixed hint. */
export type HintKey = keyof typeof hints;

/**
 * An error that carries only a fixed code and an optional fixed hint.
 *
 * The message is the code itself, so even code that prints the message by
 * mistake shows nothing from the instance.
 *
 * @example
 * ```ts
 * throw new SpikeError('KONFIGURATION', 'basisUrlFehlt');
 * ```
 */
export class SpikeError extends Error {
  /** The fixed error code. */
  readonly code: ErrorCode;

  /** The fixed hint for the person who runs the probe, if there is one. */
  readonly hint: HintKey | undefined;

  /**
   * Creates an error from a fixed code.
   *
   * @param code - One of the fixed error codes.
   * @param hint - Key of a fixed hint, if one fits.
   */
  constructor(code: ErrorCode, hint?: HintKey) {
    super(code);
    this.name = 'SpikeError';
    this.code = code;
    this.hint = hint;
  }
}
