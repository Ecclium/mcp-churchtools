/**
 * The German texts for problems and warnings of the configuration
 * (ADR 0055). The core reports only codes and names of variables; the
 * command line turns them into messages here. Every message says what
 * happens, why, and what the operator can do now. A message names
 * variables only by their names and never a value the operator entered: a
 * token can stand in the wrong variable. It may name values of the table.
 *
 * @packageDocumentation
 */
import { isProxy } from 'node:util/types';

import {
  type ConfigProblem,
  type ConfigProblemCode,
  type ConfigWarningCode,
  toolsetNames,
  variables,
} from '@ecclium/mcp-churchtools-core';

/**
 * A text from this catalog. Only the catalog makes one, through
 * {@link problemText}, {@link warningText} and the texts of the start over
 * stdio in `start.ts`, so the start notices refuse a plain string at the
 * type level. A cast or a type predicate still gets around that, which a
 * review has to catch.
 */
export type MessageText = string & { readonly __ecclium: 'MessageText' };

/** One message in its three parts, each one or more whole sentences. */
export interface Message {
  /** What happens or happened. */
  readonly what: string;
  /** Why. */
  readonly why: string;
  /** What the operator can do now. */
  readonly action: string;
}

// A name the loader may report: the prefix and capitals, digits and
// underscores, or one of the variables of Node.js it reports by name.
// Anything else is never put into a text.
const namePattern =
  /^ECCLIUM_[A-Z0-9_]{1,64}$|^NODE_TLS_REJECT_UNAUTHORIZED$|^NODE_DEBUG$|^NODE_OPTIONS$/;

const quote = (name: string): string => `‹${name}›`;

/**
 * Writes a whole number as the texts of the command line show it, with an
 * apostrophe between groups of three digits from 1000 up: 4'096.
 *
 * @param value - A whole number, 0 or more.
 * @returns The digits with their separators.
 * @throws {TypeError} When the value is no safe whole number of 0 or more.
 * @example
 * ```ts
 * formatNumber(4096); // "4'096"
 * ```
 */
export function formatNumber(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('The number cannot be formatted.');
  }
  const digits = String(value);
  let text = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) text += "'";
    text += digits.charAt(index);
  }
  return text;
}

// A field of a problem, read once and only as an own data property: a
// getter could give a checked name on one read and free text on the next.
const field = (record: object, key: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor !== undefined && 'value' in descriptor
    ? (descriptor.value as unknown)
    : undefined;
};

const message = (what: string, why: string, action: string): Message =>
  Object.freeze({ what, why, action });

// Values of the table that this version still refuses: strict until the
// full redaction exists (ADR 0055). A message never offers them.
const refusedChoices: Readonly<Record<string, readonly string[]>> =
  Object.freeze({ ECCLIUM_REDACTION: Object.freeze(['strict']) });

// The allowed values of a variable as German prose: ‹a› oder ‹b›.
const choiceList = (name: string | undefined): string => {
  const refused =
    name !== undefined && Object.hasOwn(refusedChoices, name)
      ? refusedChoices[name]
      : undefined;
  const quoted = (
    variables.find((variable) => variable.name === name)?.choices ?? []
  )
    .filter((choice) => refused?.includes(choice) !== true)
    .map(quote);
  const last = quoted.pop();
  if (last === undefined) return '';
  return quoted.length === 0 ? last : `${quoted.join(', ')} oder ${last}`;
};

const url = quote('ECCLIUM_CHURCHTOOLS_URL');
// The address passes only as a canonical origin, which is far shorter than
// the bound of the table.
const urlLength =
  'Eine Adresse hat mit https, Host und Port höchstens 268 Zeichen.';
const tokenFile = quote('ECCLIUM_CHURCHTOOLS_TOKEN_FILE');
const tokenVariable = quote('ECCLIUM_CHURCHTOOLS_TOKEN');
const stateDir = quote('ECCLIUM_STATE_DIR');
const toolsets = quote('ECCLIUM_TOOLSETS');
const personsToolset = quote('persons');
const eventsToolset = quote('events');
const apiToolset = quote('api');
// With all, there is no name to remove.
const insteadOfAll = `Steht dort ${quote('all')}, nennen Sie stattdessen die übrigen Toolsets einzeln.`;
// The names of the toolsets as German prose: ‹a›, ‹b› und ‹c›.
const toolsetList = `${toolsetNames.slice(0, -1).map(quote).join(', ')} und ${quote(toolsetNames.at(-1) ?? '')}`;
const auditDir = quote('audit');
const quotaDir = quote('quota');
const example = 'https://example.church.tools';

// Where an option of TLS was found: in NODE_OPTIONS, which the loader then
// names, or else among the options Node.js was started with.
const optionFound = (
  option: string,
  raw: string | undefined,
  why: string,
): Message =>
  raw === 'NODE_OPTIONS'
    ? message(
        `Die Option ${quote(option)} steht in ${quote(raw)}.`,
        why,
        `Entfernen Sie die Option aus ${quote(raw)} in der Konfiguration des KI-Assistenten.`,
      )
    : message(
        `Node.js läuft mit der Option ${quote(option)}.`,
        why,
        'Entfernen Sie die Option aus dem Befehl, mit dem der KI-Assistent Ecclium startet.',
      );

// One function per code. It gets the quoted name of the variable and the
// name itself, or undefined for both when the problem names none or a name
// that breaks the pattern.
const problems: Readonly<
  Record<
    ConfigProblemCode,
    (name: string | undefined, raw: string | undefined) => Message
  >
> = Object.freeze({
  unknown_variable: (name) =>
    name === undefined
      ? message(
          'Eine Variable mit dem Präfix ECCLIUM_ ist unbekannt. Ihr Name wird nicht gezeigt.',
          'Er enthält andere Zeichen als Grossbuchstaben, Ziffern und Unterstriche oder ist zu lang. Jede Variable mit diesem Präfix muss Ecclium bekannt sein, damit kein Tippfehler unbemerkt bleibt.',
          'Prüfen Sie die Namen in der Umgebung, die mit ECCLIUM_ beginnen.',
        )
      : message(
          `Die Variable ${name} ist unbekannt.`,
          'Jede Variable mit dem Präfix ECCLIUM_ muss Ecclium bekannt sein, damit kein Tippfehler unbemerkt bleibt.',
          'Prüfen Sie die Schreibweise oder entfernen Sie die Variable.',
        ),
  miscased_variable: (name) =>
    message(
      `${name ?? 'Eine Variable'} ist in einer anderen Schreibweise gesetzt.`,
      'Ecclium liest nur die genaue Schreibweise in Grossbuchstaben und übernimmt den Wert deshalb nicht.',
      name === undefined
        ? 'Schreiben Sie den Namen in Grossbuchstaben.'
        : `Schreiben Sie den Namen genau als ${name}.`,
    ),
  unsupported_variable: (name) =>
    message(
      `${name ?? 'Eine Variable'} wird von dieser Version noch nicht unterstützt.`,
      'Sie gehört zu einer späteren Version. Ein Wert, den Ecclium nicht anwendet, soll nicht still übergangen werden.',
      'Entfernen Sie die Variable.',
    ),
  // Refused whatever its value, so that no configuration loses its search
  // tools without a word (ADR 0062).
  search_tools_replaced: (name = quote('ECCLIUM_SEARCH_TOOLS')) =>
    message(
      `Die Variable ${name} gibt es nicht mehr.`,
      `An ihre Stelle tritt ${toolsets}. Ecclium übergeht sie nicht still, damit die Suchtools nicht unbemerkt wegfallen.`,
      `Ersetzen Sie ${quote('ECCLIUM_SEARCH_TOOLS=true')} durch ${quote('ECCLIUM_TOOLSETS=persons')} oder entfernen Sie die Variable.`,
    ),
  proxy_unsupported: (name = quote('ECCLIUM_EGRESS_PROXY')) =>
    message(
      `Die Variable ${name} ist gesetzt.`,
      'Ecclium unterstützt noch keinen Proxy für ausgehende Verbindungen. Ohne Abbruch gingen die Anfragen an ChurchTools am Proxy vorbei.',
      'Entfernen Sie die Variable, bis eine Version mit Proxy erscheint.',
    ),
  tls_check_disabled: (name = quote('NODE_TLS_REJECT_UNAUTHORIZED')) =>
    message(
      `Die Variable ${name} hat den Wert 0.`,
      'Damit prüfte Node.js die Zertifikate von ChurchTools nicht mehr, und das Token könnte an einen fremden Server gehen.',
      'Entfernen Sie die Variable aus der Konfiguration des KI-Assistenten.',
    ),
  debug_output_enabled: (name = quote('NODE_DEBUG')) =>
    message(
      `Die Variable ${name} schaltet die Diagnose von Node.js ein.`,
      'Damit schriebe Node.js am Protokoll vorbei nach stderr, je nach Sektion Adresse, Pfad und Suchbegriffe jeder Anfrage an ChurchTools oder Teile der Antworten.',
      'Entfernen Sie die Variable aus der Konfiguration des KI-Assistenten.',
    ),
  tls_keylog_enabled: (_name, raw) =>
    optionFound(
      '--tls-keylog',
      raw,
      'Damit schriebe Node.js die Schlüssel jeder TLS-Verbindung in eine Datei, und wer zusätzlich den Verkehr mitschneidet, könnte das Token lesen.',
    ),
  tls_trace_enabled: (_name, raw) =>
    optionFound(
      '--trace-tls',
      raw,
      'Damit schriebe Node.js den Ablauf jeder TLS-Verbindung zu ChurchTools am Protokoll vorbei nach stderr.',
    ),
  empty_value: (name) =>
    message(
      `${name ?? 'Eine Variable'} ist leer.`,
      'Ein leerer Wert gilt nicht als «nicht gesetzt», weil er meist aus einem Fehler in der Konfiguration stammt.',
      'Geben Sie einen Wert an oder entfernen Sie die Variable.',
    ),
  value_too_long: (name, raw) => {
    const variable = variables.find((entry) => entry.name === raw);
    return message(
      `Der Wert von ${name ?? 'einer Variable'} ist zu lang.`,
      variable === undefined
        ? 'Jede Variable hat eine Höchstlänge, und kein Wert wird gekürzt.'
        : raw === 'ECCLIUM_CHURCHTOOLS_URL'
          ? urlLength
          : `Erlaubt sind höchstens ${formatNumber(variable.maxLength)} Zeichen, und kein Wert wird gekürzt.`,
      'Prüfen Sie den Wert, vielleicht steht dort etwas anderes als gedacht.',
    );
  },
  invalid_choice: (name, raw) => {
    const choices = choiceList(raw);
    return message(
      `Der Wert von ${name ?? 'einer Variable'} ist nicht erlaubt.`,
      choices === ''
        ? 'Erlaubt sind nur die Werte aus der Dokumentation, in genau dieser Schreibweise.'
        : `Erlaubt sind genau ${choices}${
            // off is refused over HTTP (ADR 0055).
            raw === 'ECCLIUM_REDACTION'
              ? ', ‹off› nur im Betrieb über stdio,'
              : ','
          } in dieser Schreibweise.`,
      'Setzen Sie einen der erlaubten Werte.',
    );
  },
  invalid_toolsets: (name = toolsets) =>
    message(
      `Der Wert von ${name} ist nicht erlaubt.`,
      `Erlaubt ist eine mit Komma getrennte Liste aus ${toolsetList}, jeder Name höchstens einmal und ohne Leerzeichen, oder ‹all› allein für alle ausser ${apiToolset}, oder ‹all,api› für alle. Ein leerer Wert schaltet kein Toolset ein.`,
      'Setzen Sie eine solche Liste, etwa ‹persons,wiki›, oder entfernen Sie die Variable.',
    ),
  invalid_integer: (name = quote('ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE')) =>
    message(
      `Der Wert von ${name} ist keine erlaubte Zahl.`,
      'Erlaubt ist eine ganze Zahl von 1 bis 500, nur mit Ziffern und ohne Null am Anfang.',
      'Setzen Sie eine Zahl in diesem Bereich oder entfernen Sie die Variable, dann gilt die Voreinstellung 300.',
    ),
  url_missing: (name = url) =>
    message(
      'Die Adresse der ChurchTools-Instanz fehlt.',
      'Ohne Adresse weiss Ecclium nicht, mit welcher Instanz es sich verbinden soll.',
      `Setzen Sie ${name} auf die Adresse Ihrer Instanz, etwa ${example}.`,
    ),
  url_too_long: () =>
    message(
      'Die Adresse der ChurchTools-Instanz ist zu lang.',
      'Mit https, Host und Port hat sie höchstens 268 Zeichen.',
      'Geben Sie nur «https://» und den Host an, ohne Pfad.',
    ),
  url_invalid: () =>
    message(
      'Die Adresse der ChurchTools-Instanz ist keine gültige URL.',
      'Ecclium braucht eine vollständige Adresse mit https und Host.',
      `Geben Sie die Adresse so an, wie der Browser sie zeigt, etwa ${example}.`,
    ),
  url_not_https: () =>
    message(
      'Die Adresse der ChurchTools-Instanz verwendet nicht https.',
      'Ohne https ginge das Token unverschlüsselt über das Netz.',
      'Verwenden Sie die Adresse mit https.',
    ),
  url_credentials: () =>
    message(
      'Die Adresse der ChurchTools-Instanz enthält einen Benutzer oder ein Passwort.',
      'Zugangsdaten gehören nicht in eine Adresse, sie landen sonst in Protokollen und Konfigurationen.',
      `Entfernen Sie den Teil vor dem Zeichen @. Das Token gehört in die Datei, die ${tokenFile} nennt.`,
    ),
  url_path: () =>
    message(
      'Die Adresse der ChurchTools-Instanz enthält einen Pfad, eine Query oder ein Fragment.',
      'Ecclium braucht nur https, den Host und allenfalls den Port. Eine aus dem Browser kopierte Adresse kann ein Login-Token in der Query tragen.',
      `Geben Sie nur «https://» und den Host an, etwa ${example}.`,
    ),
  url_ip_address: () =>
    message(
      'Die Adresse der ChurchTools-Instanz ist eine IP-Adresse.',
      'Ecclium verlangt einen Hostnamen, damit das Zertifikat den Server bestätigen kann.',
      'Verwenden Sie den Hostnamen Ihrer Instanz.',
    ),
  url_trailing_dot: () =>
    message(
      'Der Host der ChurchTools-Instanz endet mit einem Punkt.',
      'Mit dem Punkt am Ende ergibt derselbe Name eine andere Origin.',
      'Entfernen Sie den Punkt am Ende.',
    ),
  url_localhost: () =>
    message(
      'Die Adresse der ChurchTools-Instanz zeigt auf localhost.',
      'Ecclium verbindet sich nur mit einer Instanz im Netz, nie mit einem Dienst auf diesem Rechner.',
      'Verwenden Sie die Adresse Ihrer ChurchTools-Instanz.',
    ),
  url_single_label: () =>
    message(
      'Der Host der ChurchTools-Instanz hat keinen Punkt.',
      'Ein Name aus einem einzigen Teil gilt nur in einem lokalen Netz und lässt sich nicht eindeutig auflösen.',
      'Geben Sie den vollständigen Hostnamen an, etwa example.church.tools.',
    ),
  url_host: () =>
    message(
      'Der Host der ChurchTools-Instanz ist kein gültiger Hostname.',
      'Erlaubt sind Buchstaben, Ziffern und Bindestriche, getrennt durch Punkte. Ein internationaler Name gilt nur als Punycode.',
      'Prüfen Sie den Host auf Tippfehler.',
    ),
  url_port: () =>
    message(
      'Die Adresse der ChurchTools-Instanz nennt den Port 0.',
      'An Port 0 ist kein Server erreichbar.',
      'Entfernen Sie den Port oder geben Sie den richtigen an.',
    ),
  url_not_canonical: () =>
    message(
      'Die Adresse der ChurchTools-Instanz ist nicht in ihrer eindeutigen Form geschrieben.',
      'Ecclium normalisiert nichts, damit die erlaubten Hosts genau der Konfiguration entsprechen. Grossbuchstaben, der Port 443, Leerzeichen, kodierte Zeichen oder Buchstaben ausserhalb von ASCII wie Umlaute und Akzente verändern die Form.',
      `Schreiben Sie die Adresse in Kleinbuchstaben, ohne Port 443 und ohne Leerzeichen und einen internationalen Namen als Punycode, etwa ${example}.`,
    ),
  token_missing: (name = tokenFile) =>
    message(
      'Das Token für ChurchTools fehlt.',
      'Ohne Token kann sich Ecclium nicht bei ChurchTools anmelden.',
      `Setzen Sie ${name} auf den absoluten Pfad einer Datei mit dem Login-Token des Dienstkontos.`,
    ),
  token_conflict: () =>
    message(
      'Das Token ist zweimal angegeben, als Datei und als Variable.',
      'Ecclium wählt nicht still eine der beiden Quellen.',
      `Behalten Sie nur ${tokenFile} und entfernen Sie ${tokenVariable}.`,
    ),
  token_file_relative: () =>
    message(
      'Der Pfad zur Token-Datei ist nicht absolut.',
      'Der KI-Assistent startet Ecclium aus einem unbekannten Ordner, und eine Tilde wird nicht ersetzt.',
      'Geben Sie den vollständigen Pfad an, der mit / beginnt.',
    ),
  token_file_platform: () =>
    message(
      'Die Token-Datei lässt sich auf diesem System nicht sicher lesen.',
      'Es fehlt die Prüfung des Eigentümers oder das Öffnen ohne Links, etwa unter Windows.',
      `Verwenden Sie dort im Betrieb über stdio die Variable ${tokenVariable}.`,
    ),
  token_file_missing: () =>
    message(
      'Die Token-Datei gibt es nicht.',
      'Ohne die Datei hat Ecclium kein Token.',
      `Prüfen Sie den Pfad in ${tokenFile}.`,
    ),
  token_file_symlink: () =>
    message(
      'Der Pfad zur Token-Datei endet in einem symbolischen Link.',
      'Ein Link könnte auf eine fremde Datei zeigen, deshalb folgt Ecclium ihm nicht.',
      'Geben Sie den Pfad der Datei selbst an.',
    ),
  token_file_unreadable: () =>
    message(
      'Die Token-Datei lässt sich nicht lesen.',
      'Dem Benutzer, unter dem Ecclium läuft, fehlt das Recht dazu.',
      'Prüfen Sie Eigentümer und Rechte der Datei. Empfohlen sind die Rechte 600.',
    ),
  token_file_not_regular: () =>
    message(
      'Der Pfad zur Token-Datei zeigt nicht auf eine gewöhnliche Datei.',
      'Ein Ordner, ein Gerät oder eine Pipe enthält kein Token, und aus einer Pipe zu lesen könnte den Start aufhalten.',
      'Geben Sie den Pfad einer gewöhnlichen Datei an.',
    ),
  token_file_owner: () =>
    message(
      'Die Token-Datei gehört einem anderen Benutzer.',
      'Wem eine Datei gehört, der kann das Token darin austauschen.',
      'Legen Sie die Datei als der Benutzer an, unter dem Ecclium läuft.',
    ),
  token_file_mode: () =>
    message(
      'Die Token-Datei ist auch für die Gruppe oder für andere Benutzer zugänglich.',
      'Dann könnten andere Benutzer das Token lesen oder austauschen.',
      'Setzen Sie die Rechte der Datei mit «chmod 600» auf 600.',
    ),
  token_file_too_large: () =>
    message(
      'Die Token-Datei ist zu gross.',
      `Ein Token hat höchstens ${formatNumber(4096)} Zeichen, mit dem Zeilenumbruch hat die Datei also höchstens ${formatNumber(4098)} Bytes.`,
      'Prüfen Sie, ob die Datei nur das Token enthält.',
    ),
  token_file_empty: () =>
    message(
      'Die Token-Datei ist leer.',
      'Sie enthält kein Token, höchstens einen Zeilenumbruch.',
      'Schreiben Sie das Login-Token des Dienstkontos in die Datei.',
    ),
  token_file_bom: () =>
    message(
      'Die Token-Datei beginnt mit einer Byte-Order-Markierung.',
      'Manche Editoren setzen sie beim Speichern. Sie gehört nicht zum Token, und Ecclium entfernt sie nicht von sich aus.',
      'Speichern Sie die Datei als UTF-8 ohne BOM oder als reinen Text.',
    ),
  token_file_characters: () =>
    message(
      'Die Token-Datei enthält Zeichen, die in einem Token nicht vorkommen.',
      'Erlaubt sind sichtbare ASCII-Zeichen und ein einziger Zeilenumbruch am Ende. Leerzeichen, Tabulatoren und weitere Zeilen gehören nicht dazu.',
      'Prüfen Sie die Datei, vielleicht steht dort mehr als das Token.',
    ),
  token_file_unsafe: () =>
    message(
      'Die Token-Datei liess sich nicht sicher öffnen.',
      'Das Dateisystem meldete einen Fehler. Seine Meldung zeigt Ecclium nicht, weil sie den Pfad enthält.',
      'Prüfen Sie den Pfad und die Ordner darüber.',
    ),
  token_invalid: (name, raw) =>
    message(
      raw === 'ECCLIUM_CHURCHTOOLS_TOKEN'
        ? `Das Token in ${name ?? tokenVariable} ist ungültig.`
        : 'Das Token in der Token-Datei ist ungültig.',
      `Ein Token hat 1 bis ${formatNumber(4096)} sichtbare ASCII-Zeichen und ist kein Platzhalter.`,
      'Kopieren Sie das Login-Token des Dienstkontos erneut aus ChurchTools.',
    ),
  redaction_strict_unsupported: () =>
    message(
      'Die Maskierung ‹strict› ist noch nicht verfügbar.',
      'Die vollständige Maskierung folgt mit einer späteren Version, und Ecclium soll nie weniger maskieren, als Sie verlangen.',
      'Verwenden Sie vorerst ‹standard›.',
    ),
  stdio_only: (name, raw) => {
    switch (raw) {
      case 'ECCLIUM_REDACTION':
        return message(
          `${quote(raw)} ist mit diesem Wert nur im Betrieb über stdio erlaubt.`,
          'Über HTTP nutzen mehrere Personen denselben Server, und die Einstellung gälte dann für alle.',
          'Setzen Sie die Variable für den Betrieb über HTTP auf ihre Voreinstellung oder entfernen Sie sie.',
        );
      case 'ECCLIUM_CHURCHTOOLS_TOKEN':
        return message(
          `${quote(raw)} ist nur im Betrieb über stdio erlaubt.`,
          'Ausserhalb des Betriebs über stdio kommt das Token nur aus einer Datei.',
          `Entfernen Sie ${quote(raw)} und nennen Sie in ${tokenFile} eine Datei mit dem Token und den Rechten 600.`,
        );
      case 'ECCLIUM_STDIO_SUBJECT':
        return message(
          `${quote(raw)} gilt nur im Betrieb über stdio.`,
          'Über HTTP kommt das Subjekt aus der Anmeldung jeder Anfrage.',
          'Entfernen Sie die Variable für den Betrieb über HTTP.',
        );
      case 'ECCLIUM_STATE_DIR':
        return message(
          `${quote(raw)} gilt vorerst nur im Betrieb über stdio.`,
          'Für den Betrieb über HTTP folgt die Audit-Datei mit einer späteren Version.',
          'Entfernen Sie die Variable für den Betrieb über HTTP.',
        );
      default:
        return message(
          `${name ?? 'Diese Einstellung'} ist nur im Betrieb über stdio erlaubt.`,
          'Über HTTP nutzen mehrere Personen denselben Server, und die Einstellung gälte dann für alle.',
          'Entfernen Sie die Variable für den Betrieb über HTTP.',
        );
    }
  },
  subject_invalid: (name = quote('ECCLIUM_STDIO_SUBJECT')) =>
    message(
      `Das Subjekt in ${name} hat keine gültige Form.`,
      'Erlaubt sind Kleinbuchstaben, Ziffern und Bindestriche, mit einem Buchstaben am Anfang und höchstens 32 Zeichen. So ist es nie eine E-Mail-Adresse.',
      'Wählen Sie eine neutrale Bezeichnung wie ‹local-stdio›, nie den Namen einer Person.',
    ),
  subject_reserved: (name = quote('ECCLIUM_STDIO_SUBJECT')) =>
    message(
      `Das Subjekt ‹invalid› in ${name} ist reserviert.`,
      'Das Audit verwendet es als Platzhalter für einen fehlenden Akteur.',
      'Wählen Sie eine andere neutrale Bezeichnung, etwa ‹local-stdio›.',
    ),
  state_dir_relative: (name = stateDir) =>
    message(
      `Der Pfad in ${name} ist nicht absolut.`,
      'Der KI-Assistent startet Ecclium aus einem unbekannten Ordner, und eine Tilde wird nicht ersetzt.',
      'Geben Sie den vollständigen Pfad an, der mit / beginnt.',
    ),
  state_dir_not_normalized: (name = stateDir) =>
    message(
      `Der Pfad in ${name} ist nicht in seiner eindeutigen Form geschrieben.`,
      'Ecclium normalisiert nichts, damit es genau den Ordner prüft, den Sie angeben. Mit einem Schrägstrich am Ende folgte die Prüfung sogar einem Link.',
      'Schreiben Sie den Pfad ohne Schrägstrich am Ende, ohne doppelte Schrägstriche und ohne ‹.› oder ‹..›.',
    ),
  state_dir_too_long: (name = stateDir) =>
    message(
      `Der Pfad in ${name} ist zu lang.`,
      `In UTF-8 hat er mehr als 960 Bytes, und der Pfad einer Audit-Datei darin überschritte die Grenze von 1'024 Bytes für Pfade unter macOS. Zeichen ausserhalb von ASCII wie Umlaute zählen mehrfach.`,
      'Wählen Sie einen kürzeren Pfad.',
    ),
  state_dir_platform: (name = stateDir) =>
    message(
      `Der Ordner in ${name} lässt sich auf diesem System nicht sicher prüfen.`,
      'Es fehlt die Prüfung des Eigentümers oder das Öffnen ohne Links, etwa unter Windows. Dort gibt es im Betrieb über stdio keine Audit-Datei und keine Suchtools.',
      'Entfernen Sie die Variable auf diesem System.',
    ),
  state_dir_missing: (name = stateDir) =>
    message(
      `Den Ordner in ${name} gibt es nicht.`,
      'Ecclium legt ihn nicht selbst an, damit er nur mit den Rechten entsteht, die Sie wählen.',
      'Legen Sie den Ordner mit den Rechten 700 an, etwa mit «mkdir -m 700» und dem Pfad, oder prüfen Sie den Pfad.',
    ),
  state_dir_symlink: (name = stateDir) =>
    message(
      `Der Pfad in ${name} endet in einem symbolischen Link.`,
      'Ein Link könnte auf einen fremden Ordner zeigen, deshalb folgt Ecclium ihm nicht.',
      'Geben Sie den Pfad des Ordners selbst an.',
    ),
  state_dir_not_directory: (name = stateDir) =>
    message(
      `Der Pfad in ${name} zeigt nicht auf einen Ordner.`,
      `Ecclium legt darin den Ordner ${auditDir} mit der Audit-Datei an.`,
      'Geben Sie den Pfad eines Ordners an.',
    ),
  state_dir_owner: (name = stateDir) =>
    message(
      `Der Ordner in ${name} gehört einem anderen Benutzer.`,
      'Wem der Ordner gehört, der kann die Audit-Datei darin lesen, austauschen oder löschen.',
      'Legen Sie den Ordner als der Benutzer an, unter dem Ecclium läuft.',
    ),
  state_dir_mode: (name = stateDir) =>
    message(
      `Der Ordner in ${name} ist auch für die Gruppe oder für andere Benutzer zugänglich.`,
      'Dann könnten andere Benutzer die Audit-Datei lesen oder Dateien darin anlegen.',
      'Setzen Sie die Rechte des Ordners mit «chmod 700» auf 700.',
    ),
  state_dir_unsafe: (name = stateDir) =>
    message(
      `Der Ordner in ${name} liess sich nicht sicher prüfen.`,
      'Das Dateisystem meldete einen Fehler. Seine Meldung zeigt Ecclium nicht, weil sie den Pfad enthält.',
      'Prüfen Sie den Pfad und die Rechte der Ordner darüber.',
    ),
  audit_dir_symlink: (name = stateDir) =>
    message(
      `Der Ordner ${auditDir} im Ordner aus ${name} ist ein symbolischer Link.`,
      'Ein Link könnte auf einen fremden Ordner zeigen, deshalb folgt Ecclium ihm nicht.',
      `Entfernen Sie den Link. Ecclium legt den Ordner ${auditDir} beim Start selbst an.`,
    ),
  audit_dir_not_directory: (name = stateDir) =>
    message(
      `Im Ordner aus ${name} ist ${auditDir} kein Ordner.`,
      `Ecclium schreibt die Audit-Datei in den Ordner ${auditDir}.`,
      `Verschieben Sie, was unter dem Namen ${auditDir} steht. Ecclium legt den Ordner beim Start selbst an.`,
    ),
  audit_dir_owner: (name = stateDir) =>
    message(
      `Der Ordner ${auditDir} im Ordner aus ${name} gehört einem anderen Benutzer.`,
      'Wem der Ordner gehört, der kann die Audit-Datei darin lesen, austauschen oder löschen.',
      `Verschieben Sie den Ordner ${auditDir}, damit frühere Audit-Dateien erhalten bleiben. Ecclium legt ihn beim Start als der Benutzer an, unter dem es läuft.`,
    ),
  audit_dir_mode: (name = stateDir) =>
    message(
      `Der Ordner ${auditDir} im Ordner aus ${name} ist auch für die Gruppe oder für andere Benutzer zugänglich.`,
      'Dann könnten andere Benutzer die Audit-Datei lesen.',
      `Setzen Sie die Rechte von ${auditDir} mit «chmod 700» auf 700.`,
    ),
  audit_dir_unsafe: (name = stateDir) =>
    message(
      `Der Ordner ${auditDir} im Ordner aus ${name} liess sich nicht sicher prüfen.`,
      'Das Dateisystem meldete einen Fehler. Seine Meldung zeigt Ecclium nicht, weil sie den Pfad enthält.',
      `Prüfen Sie Eigentümer und Rechte des Ordners aus ${name}.`,
    ),
  quota_dir_symlink: (name = stateDir) =>
    message(
      `Der Ordner ${quotaDir} im Ordner aus ${name} ist ein symbolischer Link.`,
      'Ein Link könnte auf einen fremden Ordner zeigen, deshalb folgt Ecclium ihm nicht.',
      `Entfernen Sie den Link. Ecclium legt den Ordner ${quotaDir} beim Start selbst an.`,
    ),
  quota_dir_not_directory: (name = stateDir) =>
    message(
      `Im Ordner aus ${name} ist ${quotaDir} kein Ordner.`,
      `Ecclium zählt im Ordner ${quotaDir} die Aufrufe für das Lesebudget.`,
      `Verschieben Sie, was unter dem Namen ${quotaDir} steht. Ecclium legt den Ordner beim Start selbst an.`,
    ),
  quota_dir_owner: (name = stateDir) =>
    message(
      `Der Ordner ${quotaDir} im Ordner aus ${name} gehört einem anderen Benutzer.`,
      'Wem der Ordner gehört, der kann die Zähler des Lesebudgets darin ändern oder löschen.',
      `Entfernen Sie den Ordner ${quotaDir}. Ecclium legt ihn beim Start als der Benutzer an, unter dem es läuft.`,
    ),
  quota_dir_mode: (name = stateDir) =>
    message(
      `Der Ordner ${quotaDir} im Ordner aus ${name} ist auch für die Gruppe oder für andere Benutzer zugänglich.`,
      'Dann könnten andere Benutzer die Zähler des Lesebudgets ändern.',
      `Setzen Sie die Rechte von ${quotaDir} mit «chmod 700» auf 700.`,
    ),
  quota_dir_unsafe: (name = stateDir) =>
    message(
      `Der Ordner ${quotaDir} im Ordner aus ${name} liess sich nicht sicher prüfen.`,
      'Das Dateisystem meldete einen Fehler. Seine Meldung zeigt Ecclium nicht, weil sie den Pfad enthält.',
      `Prüfen Sie Eigentümer und Rechte des Ordners aus ${name}.`,
    ),
  // Reported for the folder, which is what is missing; the toolsets
  // themselves are valid. persons and events need the folder, because
  // their tools name persons, and api, because the escape hatch passes on
  // whole answers (ADR 0028, ADR 0064, ADR 0067).
  toolsets_without_state_dir: (name = stateDir) =>
    message(
      `In ${toolsets} ist ${personsToolset}, ${eventsToolset} oder ${apiToolset} eingeschaltet, aber ${name} ist nicht gesetzt.`,
      `Tools dieser Toolsets nennen Personen oder geben ganze Antworten von ChurchTools weiter. Ein Ergebnis solcher Tools gibt Ecclium nur heraus, wenn seine Zeile in der Audit-Datei steht, und die Audit-Datei liegt im Ordner aus ${name}. Unter Windows gibt es sie im Betrieb über stdio nicht, und damit auch diese Toolsets nicht.`,
      `Setzen Sie ${name} auf einen lokalen Ordner Ihres Benutzers mit den Rechten 700 oder entfernen Sie ${personsToolset}, ${eventsToolset} und ${apiToolset} aus ${toolsets}, soweit sie dort stehen. ${insteadOfAll}`,
    ),
});

const warnings: Readonly<Record<ConfigWarningCode, Message>> = Object.freeze({
  token_from_environment: message(
    `Das Token steht in der Variable ${tokenVariable}.`,
    'Damit steht es im Klartext in der Konfiguration des KI-Assistenten, und andere Programme Ihres Benutzers können es lesen, solange Ecclium läuft.',
    `Legen Sie das Token in eine Datei mit den Rechten 600 und nennen Sie sie in ${tokenFile}.`,
  ),
  redaction_off: message(
    'Die Maskierung ist ausgeschaltet.',
    'Personendaten erreichen den KI-Assistenten unmaskiert.',
    `Setzen Sie ${quote('ECCLIUM_REDACTION')} auf ‹standard›, wenn das nicht gewollt ist.`,
  ),
  // On every start, because the tools of persons let the AI assistant see
  // names of persons and groups and their memberships (ADR 0060,
  // ADR 0064).
  persons_toolset_enabled: message(
    `Das Toolset ${personsToolset} ist eingeschaltet.`,
    'Der KI-Assistent kann damit Personen und Gruppen der Instanz nach Namen suchen und sieht Kennung und Name jedes Treffers. Er liest auch die Gruppen einer Person, die Angaben einer Gruppe mit ihrer Notiz und die Namen ihrer Mitglieder mit Rolle und Stand der Mitgliedschaft. Kontaktdaten liest er nicht. Jeder Aufruf steht in der Audit-Datei.',
    `Entfernen Sie ${personsToolset} aus ${toolsets}, wenn er diese Daten nicht sehen soll. ${insteadOfAll}`,
  ),
  // On every start, because the assignments to services let the AI
  // assistant see the names of the persons who serve (ADR 0064).
  events_toolset_enabled: message(
    `Das Toolset ${eventsToolset} ist eingeschaltet.`,
    'Der KI-Assistent kann damit Events, ihre Abläufe und die Dienste der Instanz lesen und sieht, wer in die Dienste eines Events eingeteilt ist, mit Kennung und Name, ausser bei Diensten, die die Namen verbergen. Kontaktdaten liest er nicht. Jeder Aufruf der Einteilungen steht in der Audit-Datei.',
    `Entfernen Sie ${eventsToolset} aus ${toolsets}, wenn er diese Daten nicht sehen soll. ${insteadOfAll}`,
  ),
  // On every start, because the escape hatch passes on whole answers of
  // ChurchTools, not fixed fields (ADR 0067). all never turns it on.
  api_toolset_enabled: message(
    `Das Toolset ${apiToolset} ist eingeschaltet.`,
    'Der KI-Assistent kann damit jede lesende Operation der API aufrufen, die Ecclium freigibt, und sieht die ganze Antwort, soweit das Dienstkonto sie sehen darf. E-Mail-Adressen, Telefonnummern und Geburtsdaten sind maskiert, Adressen, Notizen und andere Angaben nicht. Jeder Aufruf steht in der Audit-Datei und zählt gegen das Lesebudget.',
    `Entfernen Sie ${apiToolset} aus ${toolsets}, wenn er das nicht soll.`,
  ),
  // One text for every setting: the report of the loader names none of
  // them, and never the path of a certificate.
  trust_store_extended: message(
    'Node.js vertraut nicht nur den mitgelieferten Zertifizierungsstellen.',
    'Mindestens eine der Einstellungen ‹NODE_EXTRA_CA_CERTS›, ‹NODE_USE_SYSTEM_CA›, ‹SSL_CERT_FILE›, ‹SSL_CERT_DIR›, ‹--use-system-ca› und ‹--use-openssl-ca› ist gesetzt. Wer eine der zusätzlichen Zertifizierungsstellen kontrolliert, kann sich als Ihre ChurchTools-Instanz ausgeben und das Token mitlesen.',
    'Behalten Sie die Einstellung nur, wenn das Zertifikat Ihrer Instanz von einer eigenen Zertifizierungsstelle stammt. Sonst entfernen Sie sie aus der Konfiguration des KI-Assistenten.',
  ),
});

/**
 * The message for a problem of the configuration. Code and variable are
 * read once, as own data properties; a getter is never run. The name of
 * the variable appears only when it fits the pattern of names the loader
 * reports; a value never does.
 *
 * @param problem - A problem from the report of the loader.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the problem is no plain record or its code is
 *   none of the catalog.
 * @example
 * ```ts
 * problemMessage({ code: 'url_missing', variable: 'ECCLIUM_CHURCHTOOLS_URL' }).action;
 * ```
 */
export function problemMessage(problem: ConfigProblem): Message {
  const given: unknown = problem;
  if (typeof given !== 'object' || given === null || isProxy(given)) {
    throw new TypeError('The problem code is unknown.');
  }
  // Own keys only: a code such as toString must not reach a method of
  // Object.prototype.
  const code = field(given, 'code');
  if (typeof code !== 'string' || !Object.hasOwn(problems, code)) {
    throw new TypeError('The problem code is unknown.');
  }
  const variable = field(given, 'variable');
  const raw =
    typeof variable === 'string' && namePattern.test(variable)
      ? variable
      : undefined;
  return problems[code as ConfigProblemCode](
    raw === undefined ? undefined : quote(raw),
    raw,
  );
}

/**
 * The message for a warning of the configuration.
 *
 * @param code - A warning from the report of the loader.
 * @returns The message in its three parts, frozen.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * warningMessage('redaction_off').why;
 * ```
 */
export function warningMessage(code: ConfigWarningCode): Message {
  const given: unknown = code;
  if (typeof given !== 'string' || !Object.hasOwn(warnings, given)) {
    throw new TypeError('The warning code is unknown.');
  }
  return warnings[code];
}

// The three parts as one text. Not exported: a caller could otherwise
// turn any object with three strings into a text of the catalog.
const joined = (parts: Message): MessageText =>
  `${parts.what} ${parts.why} ${parts.action}` as MessageText;

/**
 * The text for a problem of the configuration: its message in one line,
 * what happens first.
 *
 * @param problem - A problem from the report of the loader.
 * @returns The text of the catalog.
 * @throws {TypeError} When the problem is no plain record or its code is
 *   none of the catalog.
 * @example
 * ```ts
 * problemText({ code: 'url_missing', variable: 'ECCLIUM_CHURCHTOOLS_URL' });
 * ```
 */
export function problemText(problem: ConfigProblem): MessageText {
  return joined(problemMessage(problem));
}

/**
 * The text for a warning of the configuration, in one line.
 *
 * @param code - A warning from the report of the loader.
 * @returns The text of the catalog.
 * @throws {TypeError} When the code is none of the catalog.
 * @example
 * ```ts
 * warningText('redaction_off');
 * ```
 */
export function warningText(code: ConfigWarningCode): MessageText {
  return joined(warningMessage(code));
}
