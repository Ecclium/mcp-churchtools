/**
 * The prompt `wiki_seite_entwerfen`: the draft of a wiki page from the
 * keywords of the person, with a proposed category (ADR 0065).
 *
 * @packageDocumentation
 */
import {
  maxPromptTextArgumentLength,
  type PromptDefinition,
} from '@ecclium/mcp-churchtools-plugin-api';

// German like the other prompt, naming no tool. Until the write tools come,
// the prompt only drafts: it says so in the text, so the model does not
// look for a way to create the page. The keywords are the words of the
// person in their own message; the core removes characters they cannot see.
const text = `Entwurf einer Seite für das Wiki in ChurchTools aus diesen Stichworten:

{stichworte}

Vorgehen:
1. Die Kategorien des Wikis lesen.
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
