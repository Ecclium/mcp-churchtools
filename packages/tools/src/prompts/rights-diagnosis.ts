/**
 * The prompt `rechte_diagnose`: which right the service account lacks
 * after a failed access, from the account and the docs index (ADR 0065).
 *
 * @packageDocumentation
 */
import {
  maxPromptTextArgumentLength,
  type PromptDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';

// German like the other prompts, naming no tool. One text argument: the
// person sees no error code, only the sentence of the error, and a single
// value is the easiest to type as a command. What failed may be a tool, an
// operationId or a request by method and path; for a tool the rights stand
// in its description and in the lines of the error. Step 6 keeps the
// diagnosis from widening the account beyond what the guide to the
// service account allows: no security level of persons, which already
// at its lowest sends contact data and birthday (ADR 0060, ADR 0064), no
// right to write, no «Alle», no right a finding shows as not needed.
// Step 7 tells failures without a missing right from those with one,
// because a rule of Ecclium or a refused token opens with no right.
const text = `Diagnose der Rechte nach einem fehlgeschlagenen Zugriff auf ChurchTools. Fehlgeschlagen ist:

{zugriff}

Vorgehen:
1. Das Konto des Servers und die Rechte lesen, die ChurchTools ihm gibt.
2. Die Operation bestimmen: Steht eine operationId oder Methode und Pfad da, die Operation damit in der Dokumentation nachschlagen. Steht der Name eines Tools von Ecclium da, die Rechte aus seiner Beschreibung und aus der Meldung nehmen. Ist nur das Vorhaben beschrieben, die passende Operation in der Dokumentation suchen.
3. Jedes Recht, das die Operation oder das Tool verlangt, in der Dokumentation nachschlagen: Bezeichnung, was ohne das Recht geschieht, und die Hilfeseiten, die erklären, wo es vergeben wird.
4. Die verlangten Rechte mit denen des Kontos vergleichen. Ein Recht mit einer Liste von IDs gilt nur für diese, etwa für bestimmte Bereiche, Gruppentypen oder Kategorien. Hat das Konto ein Recht, womöglich aber nicht für das gelesene Objekt, das sagen. Rechte, die das Konto über eine Gruppe erhält, kann die Liste seiner Rechte auslassen.
5. Das Ergebnis nennen: je fehlendes Recht Modul, Name und Bezeichnung, für welche Objekte es nötig ist, und die Hilfeseite mit Titel und Link. Nur Rechte nennen, die die Dokumentation mit Beleg verlangt. Nennt sie für die Operation keine Rechte, das sagen: Dann ist offen, welches Recht fehlt, nicht, dass keines nötig ist.
6. Keine Rechte vorschlagen, die die Dokumentation als nicht nötig nennt, keine Sicherheitsstufe für Personen, kein Recht zum Schreiben oder Verwalten und nicht «Alle». Verlangt der Zugriff eine Sicherheitsstufe für Personen, das sagen und davon abraten, weil schon die niedrigste Stufe E-Mail, Telefon, Geburtstag, Postleitzahl und Ort jeder gelesenen Person mitschickt.
7. Liegt es nicht an einem Recht, das sagen: Ein abgewiesenes Token betrifft den Zugang des Kontos, nicht seine Rechte. Eine Regel von Ecclium, etwa ein fehlendes Toolset, das Lesebudget, die Audit-Datei oder eine Operation, die Ecclium nie liest, öffnet kein Recht in ChurchTools. Eine ungültige Eingabe liegt am Aufruf. Ein leeres Ergebnis kann «nichts gefunden» oder ein fehlendes Recht heissen.

Die Diagnose bleibt in diesem Gespräch: nichts in ChurchTools ändern. Rechte vergibt eine Person, die in ChurchTools Rechte verwalten darf, danach lässt sich der Zugriff wiederholen.`;

/**
 * The prompt «Rechte-Diagnose bei einem fehlgeschlagenen Zugriff». It takes
 * what failed as text of up to 2'000 characters and relies on `ct_whoami`
 * and four docs tools, so the catalog offers it with the toolset `docs`,
 * and the plugin of the core adds it only with a docs index.
 */
export const rightsDiagnosisPrompt: PromptDefinition = Object.freeze({
  name: 'rechte_diagnose',
  title: 'Rechte-Diagnose bei einem fehlgeschlagenen Zugriff',
  description:
    'Findet heraus, welches Recht dem Dienstkonto für einen fehlgeschlagenen Zugriff fehlt und wo Sie es in ChurchTools vergeben. Der KI-Assistent liest dafür das Konto des Servers und die Dokumentation, die mit Ecclium kommt, und ändert nichts.',
  tools: Object.freeze([
    'ct_whoami',
    'ct_docs_search_api',
    'ct_docs_get_operation',
    'ct_docs_get_right',
    'ct_docs_read_academy',
  ] as const),
  arguments: Object.freeze([
    Object.freeze({
      name: 'zugriff',
      description:
        'Was fehlgeschlagen ist: das Tool, die operationId oder Methode und Pfad, etwa GET /api/groups/12/members, und wenn möglich die Meldung.',
      kind: 'text',
      maxLength: maxPromptTextArgumentLength,
    } as const),
  ]),
  text,
});
