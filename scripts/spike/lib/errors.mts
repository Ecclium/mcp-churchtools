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
  platzhalterHost:
    'Abbruch: ECCLIUM_SPIKE_BASE_URL ist noch der Platzhalter aus dem README. Tragen Sie die Adresse der Testinstanz ein.',
  schalterFehlt:
    'Abbruch: ECCLIUM_SPIKE_ALLOW_WRITE fehlt. Proben mit dem Schreibkonto laufen nur mit diesem Schalter.',
  schalterFalsch:
    'Abbruch: ECCLIUM_SPIKE_ALLOW_WRITE passt nicht zum Host. Tippen Sie den ersten Teil des Hosts von Hand, nicht aus der Variablen der Adresse.',
  zweiTokenVariablen:
    'Abbruch: ECCLIUM_SPIKE_TOKEN_FILE ist gesetzt. Proben mit dem Schreibkonto lesen das Token nur aus ECCLIUM_SPIKE_WRITE_TOKEN_FILE. Lassen Sie die andere Variable im Aufruf weg.',
  schreibTokenDateiFehlt: 'Abbruch: ECCLIUM_SPIKE_WRITE_TOKEN_FILE fehlt.',
  schreibTokenDateiNichtGefunden:
    'Abbruch: Die Token-Datei des Schreibkontos wurde nicht gefunden. Prüfen Sie den Pfad in ECCLIUM_SPIKE_WRITE_TOKEN_FILE.',
  schreibKategorieFehlt:
    'Abbruch: ECCLIUM_SPIKE_WRITE_CATEGORY_ID fehlt oder ist keine positive ganze Zahl.',
  schreibStateFehlt: 'Abbruch: ECCLIUM_SPIKE_WRITE_STATE_FILE fehlt.',
  schreibStateVorhanden:
    'Abbruch: Die Schreib-State-Datei existiert schon. 05-wiki-write legt sie bei jedem Lauf neu an. Wählen Sie einen neuen Pfad und behalten Sie die alte Datei für 07-wiki-cleanup.',
  schreibStateUnsicher:
    'Abbruch: Die Schreib-State-Datei muss eine reguläre Datei des aufrufenden Benutzers sein, ohne Rechte für andere und ausserhalb eines Git-Arbeitsbaums.',
  schreibStateNichtGefunden:
    'Abbruch: Die Schreib-State-Datei wurde nicht gefunden. Sie entsteht in 05-wiki-write.',
  schreibStateUngueltig:
    'Abbruch: Die Schreib-State-Datei ist beschädigt, stammt nicht von 05-wiki-write oder gehört zu einer anderen Instanz oder Kategorie.',
  waechterOperationFehlt:
    'Abbruch: Die Instanz dokumentiert eine Operation nicht, die der Wächter braucht. Sie gilt deshalb als produktiv. Es wurde nichts geschrieben.',
  waechterAntwortUnerwartet:
    'Abbruch: Eine Antwort, die der Wächter prüft, hat nicht die dokumentierte Form. Die Instanz gilt deshalb als produktiv. Es wurde nichts geschrieben.',
  kennkategorieFehlt:
    'Abbruch: Das Konto sieht keine Kategorie «testinstanz-kennung». Die Instanz gilt deshalb als produktiv. Es wurde nichts geschrieben.',
  kennkategorieMehrfach:
    'Abbruch: Das Konto sieht mehr als eine Kategorie «testinstanz-kennung». Es wurde nichts geschrieben.',
  kennkategorieBearbeitbar:
    'Abbruch: Das Konto darf die Kennkategorie bearbeiten oder löschen. Es darf sie nur sehen.',
  schreibKategorieNichtSichtbar:
    'Abbruch: Das Konto sieht die Kategorie aus ECCLIUM_SPIKE_WRITE_CATEGORY_ID nicht.',
  schreibKategorieIstKennung:
    'Abbruch: ECCLIUM_SPIKE_WRITE_CATEGORY_ID nennt die Kennkategorie. Geschrieben wird nur im Schreibbereich.',
  schreibKategorieNichtBearbeitbar:
    'Abbruch: Das Konto darf den Schreibbereich nicht bearbeiten.',
  weitereKategorien:
    'Abbruch: Das Konto sieht ausser dem Schreibbereich und der Kennkategorie weitere Kategorien. Schränken Sie seine Rechte ein, wie im README beschrieben.',
  zuWeitBerechtigt:
    'Abbruch: Die Rechte des Kontos passen nicht. Erlaubt sind genau: das Wiki sehen, den Schreibbereich und die Kennkategorie sehen, den Schreibbereich bearbeiten. Richten Sie die Rechte so ein, wie im README beschrieben.',
  fremdeSeiten:
    'Abbruch: Im Schreibbereich liegen Seiten, die nicht zu diesem Lauf gehören. Entfernen Sie sie zuerst, mit 07-wiki-cleanup und der Schreib-State-Datei des früheren Laufs oder von Hand. Es wurde nichts geändert.',
  keinTerminal:
    'Abbruch: Die Bestätigung braucht ein Terminal. Starten Sie die Probe direkt im Terminal, ohne umgeleitete Eingabe.',
  nichtBestaetigt: 'Abbruch: nicht bestätigt. Es wurde nichts geändert.',
  leseOperationFehlt:
    'Abbruch: Die Instanz dokumentiert eine Operation nicht, mit der die Probe ihre Seiten zurückliest. Es wurde nichts geschrieben.',
  schreibenAbgebrochen:
    'Abbruch nach einer schreibenden Anfrage. Es folgt keine weitere. Prüfen Sie den Schreibbereich und räumen Sie mit 07-wiki-cleanup und derselben Schreib-State-Datei auf.',
  personenSchalterFehlt:
    'Abbruch: ECCLIUM_SPIKE_ALLOW_PERSONS fehlt. Die Probe für Personen und Gruppen läuft nur mit diesem Schalter. Es wurden keine Personendaten gelesen.',
  personenSchalterFalsch:
    'Abbruch: ECCLIUM_SPIKE_ALLOW_PERSONS passt nicht zum Host. Tippen Sie den ersten Teil des Hosts von Hand, nicht aus der Variablen der Adresse. Es wurden keine Personendaten gelesen.',
  personIdFehlt:
    'Abbruch: ECCLIUM_SPIKE_PERSON_ID fehlt oder ist keine positive ganze Zahl. Es wurden keine Personendaten gelesen.',
  gruppenIdFehlt:
    'Abbruch: ECCLIUM_SPIKE_GROUP_ID fehlt oder ist keine positive ganze Zahl. Es wurden keine Personendaten gelesen.',
  andereGruppenIdFehlt:
    'Abbruch: ECCLIUM_SPIKE_OTHER_GROUP_ID fehlt oder ist keine positive ganze Zahl. Es wurden keine Personendaten gelesen.',
  gruppenGleich:
    'Abbruch: ECCLIUM_SPIKE_GROUP_ID und ECCLIUM_SPIKE_OTHER_GROUP_ID nennen dieselbe Gruppe. Es wurden keine Personendaten gelesen.',
  personenWaechterOperationFehlt:
    'Abbruch: Die Instanz dokumentiert eine Operation nicht, die der Wächter für Personendaten braucht. Sie gilt deshalb als produktiv. Es wurden keine Personendaten gelesen.',
  personenWaechterAntwortUnerwartet:
    'Abbruch: Eine Antwort, die der Wächter für Personendaten prüft, hat nicht die dokumentierte Form. Die Instanz gilt deshalb als produktiv. Es wurden keine Personendaten gelesen.',
  personenKennkategorieFehlt:
    'Abbruch: Das Konto sieht keine Kategorie «testinstanz-kennung». Die Instanz gilt deshalb als produktiv. Es wurden keine Personendaten gelesen.',
  personenKennkategorieMehrfach:
    'Abbruch: Das Konto sieht mehr als eine Kategorie «testinstanz-kennung». Es wurden keine Personendaten gelesen.',
  personenKennkategorieBearbeitbar:
    'Abbruch: Das Konto darf die Kennkategorie bearbeiten oder löschen. Es darf sie nur sehen. Es wurden keine Personendaten gelesen.',
  personenWeitereKategorien:
    'Abbruch: Das Konto sieht ausser der Kennkategorie weitere Kategorien. Schränken Sie seine Rechte ein, wie im README beschrieben. Es wurden keine Personendaten gelesen.',
  personenZuWeitBerechtigt:
    'Abbruch: Die Rechte des Kontos passen nicht. Erlaubt sind genau: das Wiki und die Kennkategorie sehen, dazu die Leserechte für Personen und Gruppen aus dem README. Richten Sie die Rechte so ein, wie im README beschrieben. Es wurden keine Personendaten gelesen.',
  spezifikationUngueltig:
    'Abbruch: Die Instanz liefert unter dem erwarteten Pfad kein OpenAPI-Dokument.',
  smokeAufruf:
    'Abbruch: Der Smoke-Test nimmt keine Argumente. Er liest alles aus der Umgebung, siehe docs/betrieb/stdio.md.',
  smokeWindows:
    'Abbruch: Unter Windows gibt es über stdio keine Audit-Datei. Der Smoke-Test läuft dort nicht.',
  smokeUmgebungUnsicher:
    'Abbruch: Eine Variable ist gesetzt, die Node.js Code, Zertifikate oder einen Proxy unterschiebt (NODE_OPTIONS, NODE_DEBUG, NODE_PATH, NODE_EXTRA_CA_CERTS, NODE_USE_SYSTEM_CA, SSL_CERT_FILE, SSL_CERT_DIR, NODE_USE_ENV_PROXY oder NODE_TLS_REJECT_UNAUTHORIZED=0). Starten Sie den Smoke-Test mit env -i, wie in docs/betrieb/stdio.md beschrieben.',
  smokeAdresseFehlt: 'Abbruch: ECCLIUM_CHURCHTOOLS_URL fehlt.',
  smokeAdresseUngueltig:
    'Abbruch: ECCLIUM_CHURCHTOOLS_URL muss eine https-Adresse ohne Benutzer, Pfad, Query, Fragment und Schrägstrich am Ende sein.',
  smokePlatzhalter:
    'Abbruch: ECCLIUM_CHURCHTOOLS_URL ist noch der Platzhalter aus der Doku. Tragen Sie die Adresse Ihrer Instanz ein.',
  smokeTokenVariable:
    'Abbruch: ECCLIUM_CHURCHTOOLS_TOKEN ist gesetzt. Der Smoke-Test nimmt das Token nur aus der Datei in ECCLIUM_CHURCHTOOLS_TOKEN_FILE. Lassen Sie die Variable im Aufruf weg.',
  smokeTokenDateiFehlt: 'Abbruch: ECCLIUM_CHURCHTOOLS_TOKEN_FILE fehlt.',
  smokeTokenDateiRelativ:
    'Abbruch: ECCLIUM_CHURCHTOOLS_TOKEN_FILE muss ein absoluter Pfad sein, ohne ~ und ohne Variable.',
  smokeTokenDateiNichtGefunden:
    'Abbruch: Die Token-Datei wurde nicht gefunden. Prüfen Sie den Pfad in ECCLIUM_CHURCHTOOLS_TOKEN_FILE.',
  smokeTokenDateiUnsicher:
    'Abbruch: Die Token-Datei muss eine reguläre Datei des aufrufenden Benutzers sein, ohne Rechte für andere, höchstens 4 KiB gross und ausserhalb eines Git-Arbeitsbaums.',
  smokeTokenUngueltig:
    'Abbruch: Die Token-Datei muss genau eine Zeile aus druckbaren ASCII-Zeichen ohne Leerzeichen enthalten.',
  smokeSuchbegriffOhneSchalter:
    'Abbruch: ECCLIUM_SMOKE_QUERY ist gesetzt, ECCLIUM_SMOKE_ALLOW_SEARCH fehlt. Die Suchtools ruft der Smoke-Test nur mit dem Schalter auf.',
  smokeSuchbegriffFehlt:
    'Abbruch: Mit ECCLIUM_SMOKE_ALLOW_SEARCH braucht der Smoke-Test einen Suchbegriff in ECCLIUM_SMOKE_QUERY.',
  smokeSuchbegriffUngueltig:
    'Abbruch: ECCLIUM_SMOKE_QUERY braucht 1 bis 100 Zeichen ohne Leerzeichen am Rand und ohne Steuerzeichen.',
  smokeSchalterFehlt:
    'Abbruch: ECCLIUM_SMOKE_ALLOW_SEARCH fehlt. Die Suchtools wurden nicht aufgerufen.',
  smokeSchalterFalsch:
    'Abbruch: ECCLIUM_SMOKE_ALLOW_SEARCH passt nicht zum Host. Tippen Sie den ersten Teil des Hosts von Hand, nicht aus der Variablen der Adresse. Die Suchtools wurden nicht aufgerufen.',
  smokeWaechterAntwortUnerwartet:
    'Abbruch: Eine Antwort, die der Wächter des Smoke-Tests prüft, hat nicht die dokumentierte Form. Die Instanz gilt deshalb als produktiv. Die Suchtools wurden nicht aufgerufen.',
  smokeKennkategorieFehlt:
    'Abbruch: Das Konto sieht keine Kategorie «testinstanz-kennung». Die Instanz gilt deshalb als produktiv. Die Suchtools wurden nicht aufgerufen.',
  smokeKennkategorieMehrfach:
    'Abbruch: Das Konto sieht mehr als eine Kategorie «testinstanz-kennung». Die Suchtools wurden nicht aufgerufen.',
  smokeKennkategorieBearbeitbar:
    'Abbruch: Das Konto darf die Kennkategorie bearbeiten oder löschen. Es darf sie nur sehen. Die Suchtools wurden nicht aufgerufen.',
  smokeTokenAbgewiesen:
    'Abbruch: ChurchTools weist das Token des Dienstkontos ab. Prüfen Sie die Token-Datei, etwa nach einem Erneuern des Tokens. Die Suchtools wurden nicht aufgerufen.',
  smokeBuildFehlt:
    'Abbruch: Der gebaute Server fehlt (packages/cli/dist/bin.js). Bauen Sie zuerst mit pnpm build, wie in docs/betrieb/stdio.md beschrieben.',
  smokeZustandsordner:
    'Abbruch: Der Smoke-Test konnte im temporären Ordner keinen eigenen Zustandsordner anlegen.',
  smokeNetz:
    'Abbruch: Die Instanz ist für den Wächter nicht erreichbar. Code siehe oben. Die Suchtools wurden nicht aufgerufen.',
  smokeIntern:
    'Abbruch: Unerwarteter Fehler im Smoke-Test. Es wurde nichts aus den Antworten ausgegeben.',
  smokeZurueckgehalten:
    'Ausgabe zurückgehalten: An den genannten Stellen stünden womöglich Daten aus der Instanz. Nichts davon wurde ausgegeben.',
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
