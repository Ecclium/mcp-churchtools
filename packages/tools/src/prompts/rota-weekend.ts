/**
 * The prompt `dienstplan_wochenende`: an overview of the services of one
 * weekend, from the events, the services and the assignments (ADR 0065).
 *
 * @packageDocumentation
 */
import type { PromptDefinition } from '@ecclium/mcp-churchtools-plugin-api';

// The text is German, like routines and templates: the person picks the
// prompt and reads it as their own message. It names no tool; the model
// finds them by their descriptions, and the catalog offers the prompt only
// with all three. Each list may come in pages, so every step that reads
// one asks for all of them. Steps 2 and 5 exist because an assignment has
// no person both when the service hides the names and when ChurchTools
// names nobody, because nobody is assigned or a name is missing; only the
// list of services tells the first case from the others, and the second
// stays «keine Person genannt» rather than «offen». «Angenommen» rests on
// isAccepted alone, because what agreed means is not proven. The times
// come in UTC, which a person would misread as local time.
const text = `Überblick über den Dienstplan für das Wochenende von Samstag, {samstag}, und dem Sonntag danach.

Vorgehen:
1. Die Events dieser beiden Tage aus ChurchTools lesen, bei weiteren Seiten auch diese.
2. Die Dienste lesen, bei weiteren Seiten auch diese, um zu wissen, welche Dienste die Namen der Eingeteilten verbergen.
3. Für jedes Event, das nicht abgesagt ist, alle Einteilungen lesen, bei weiteren Seiten auch diese.
4. Die Events nach Beginn ordnen. Je Event Name, Tag und Uhrzeit nennen, darunter je Dienst die eingeteilte Person und ob sie die Einteilung angenommen hat. ChurchTools gibt die Zeiten in UTC: in die Zeit der Gemeinde umrechnen, wenn ihre Zeitzone bekannt ist, sonst «UTC» dazuschreiben.
5. Nennt eine Einteilung keine Person, bei einem Dienst, der die Namen verbirgt, «Name verborgen» schreiben, sonst «keine Person genannt». Keine Namen, Dienste oder Zeiten ergänzen, die nicht in den Ergebnissen stehen.
6. Abgesagte Events nur mit dem Hinweis «abgesagt» nennen.
7. Am Ende alle Einteilungen auflisten, die noch nicht angenommen sind.

Der Überblick bleibt in diesem Gespräch: nichts in ChurchTools ändern und niemanden benachrichtigen.`;

/**
 * The prompt «Dienstplan-Überblick für ein Wochenende». It takes the
 * Saturday of the weekend, which the core checks to be a Saturday, and
 * relies on `ct_events_list`, `ct_services_list` and
 * `ct_services_get_assignments`, so the catalog offers it with the toolset
 * `events`.
 */
export const rotaWeekendPrompt: PromptDefinition = Object.freeze({
  name: 'dienstplan_wochenende',
  title: 'Dienstplan-Überblick für ein Wochenende',
  description:
    'Fasst zusammen, wer an einem Wochenende welchen Dienst hat und welche Einteilungen noch nicht angenommen sind. Der KI-Assistent liest dafür Events, Dienste und Einteilungen aus ChurchTools und ändert nichts.',
  tools: Object.freeze([
    'ct_events_list',
    'ct_services_list',
    'ct_services_get_assignments',
  ] as const),
  arguments: Object.freeze([
    Object.freeze({
      name: 'samstag',
      description:
        'Samstag des Wochenendes im Format JJJJ-MM-TT, zum Beispiel 2026-10-31.',
      kind: 'date',
      weekday: 6,
    } as const),
  ]),
  text,
});
