/**
 * The prompt `wiki_seite_entwerfen`: the draft of a wiki page from the
 * keywords of the person, with a proposed category (ADR 0065). It has two
 * fixed versions under one name: one that only drafts, for a server that
 * only reads, and one that creates the page once the person agrees, for a
 * server that writes. The plugin of the core adds the one that fits, so
 * that a person finds the same command either way.
 *
 * @packageDocumentation
 */
import {
  maxPromptTextArgumentLength,
  type PromptDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';

// German like the other prompt, naming no tool. For a server that only
// reads, the prompt only drafts: it says so in the text, so the model does
// not look for a way to create the page. The keywords are the words of the
// person in their own message; the core removes characters they cannot see.
const text = `Entwurf einer Seite für das Wiki in ChurchTools aus diesen Stichworten:

{stichworte}

Vorgehen:
1. Die Kategorien des Wikis lesen, bei weiteren Seiten auch diese.
2. Im Wiki nach zwei oder drei Begriffen aus den Stichworten suchen, um Seiten zum selben Thema zu finden, und eine passende Seite bei Bedarf lesen.
3. Den Entwurf in Markdown schreiben: Titel, ein Satz zum Zweck der Seite, dann Abschnitte mit Überschriften. Nur verwenden, was in den Stichworten steht. Wo etwas fehlt, «[offen: …]» schreiben, statt etwas zu ergänzen.
4. Eine Kategorie aus der Liste vorschlagen und die Wahl in einem Satz begründen. Passt keine, das sagen.
5. Gefundene Seiten zum selben Thema mit Titel und Kategorie nennen, damit keine zweite Seite dazu entsteht.

Ecclium legt die Seite nicht an. Den Entwurf so ausgeben, dass er sich kopieren lässt, und nichts in ChurchTools ändern.`;

/**
 * The prompt «Wiki-Seite aus Stichworten». It takes keywords of up to 2'000
 * characters and relies on `ct_wiki_categories_list`, `ct_wiki_search` and
 * `ct_wiki_page_get`, so the catalog offers it with the toolset `wiki`.
 */
export const wikiDraftPrompt: PromptDefinition = Object.freeze({
  name: 'wiki_seite_entwerfen',
  title: 'Wiki-Seite aus Stichworten',
  description:
    'Macht aus Ihren Stichworten den Entwurf einer Wiki-Seite in Markdown und schlägt eine Kategorie vor. Der KI-Assistent liest dafür Kategorien und ähnliche Seiten aus ChurchTools. Die Seite legt Ecclium nicht an.',
  tools: Object.freeze([
    'ct_wiki_categories_list',
    'ct_wiki_search',
    'ct_wiki_page_get',
  ] as const),
  arguments: Object.freeze([
    Object.freeze({
      name: 'stichworte',
      description:
        "Stichworte oder kurze Sätze zum Inhalt der Seite, höchstens 2'000 Zeichen.",
      kind: 'text',
      maxLength: maxPromptTextArgumentLength,
    } as const),
  ]),
  text,
});

// The version for a server that writes. It drafts as the other does, then
// shows the draft and creates the page only after a clear yes; the core
// asks once more before it writes, or hands the write to the operator,
// and adds the line of the marking itself (ADR 0029, ADR 0032). Only the
// Markdown the content policy takes is asked for, so that a draft the
// person agreed to is not refused when it is written (ADR 0030).
const createText = `Seite für das Wiki in ChurchTools aus diesen Stichworten:

{stichworte}

Vorgehen:
1. Die Kategorien des Wikis lesen, bei weiteren Seiten auch diese.
2. Im Wiki nach zwei oder drei Begriffen aus den Stichworten suchen, um Seiten zum selben Thema zu finden, und eine passende Seite bei Bedarf lesen.
3. Den Entwurf in Markdown schreiben: ein Satz zum Zweck der Seite, dann Abschnitte mit Überschriften. Nur Überschriften, Absätze, Listen, Tabellen und Hervorhebung verwenden, keine Links, Webadressen, Bilder, kein HTML, keinen Code und keine Zitate. E-Mail-Adressen, Telefonnummern und andere Kontaktangaben nur, wenn der Betreiber sie freigegeben hat. Nur verwenden, was in den Stichworten steht. Wo etwas fehlt, «[offen: …]» schreiben, statt etwas zu ergänzen.
4. Eine Kategorie aus der Liste vorschlagen und die Wahl in einem Satz begründen. Passt keine, das sagen und keine Seite anlegen. Die Seiten dieser Kategorie lesen und einen Titel vorschlagen, den es dort noch nicht gibt.
5. Gefundene Seiten zum selben Thema mit Titel und Kategorie nennen. Gibt es schon eine, keine zweite anlegen, sondern vorschlagen, dort einen Abschnitt anzuhängen.
6. Entwurf, Titel und Kategorie zeigen und fragen, ob die Seite so angelegt werden soll. Erst nach einem klaren Ja anlegen, mit genau diesem Text. Vor dem Schreiben fragt Ecclium noch einmal nach oder gibt den Vorgang dem Betreiber zur Freigabe. Die Zeile, die die Seite als von Ecclium erstellt kennzeichnet, setzt Ecclium selbst. Lehnt Ecclium den Text ab, den Grund nennen, den angepassten Entwurf zeigen und erneut fragen.

Ohne dieses Ja nichts in ChurchTools ändern.`;

/**
 * The prompt «Wiki-Seite aus Stichworten» for a server that writes. It
 * takes the same keywords and relies, besides the three tools of the
 * draft, on `ct_wiki_pages_list`, to find a title not yet taken, and on
 * `ct_wiki_page_create`, so the catalog offers it only while the server
 * writes.
 */
export const wikiCreatePrompt: PromptDefinition = Object.freeze({
  name: 'wiki_seite_entwerfen',
  title: 'Wiki-Seite aus Stichworten',
  description:
    'Macht aus Ihren Stichworten den Entwurf einer Wiki-Seite in Markdown, schlägt Titel und Kategorie vor und legt die Seite an, wenn Sie zustimmen. Vor dem Schreiben fragt Ecclium noch einmal nach oder gibt den Vorgang dem Betreiber zur Freigabe.',
  tools: Object.freeze([
    'ct_wiki_categories_list',
    'ct_wiki_pages_list',
    'ct_wiki_search',
    'ct_wiki_page_get',
    'ct_wiki_page_create',
  ] as const),
  arguments: wikiDraftPrompt.arguments,
  text: createText,
});
