/**
 * Renders `docs/configuration.md`, the reference of the configuration, from
 * the table of the variables in the core (ADR 0055) and their German
 * descriptions in the command line. A test compares the page with the
 * file, so a changed variable without a new page turns CI red.
 *
 * @packageDocumentation
 */
import { variableDescriptions } from '@ecclium/mcp-churchtools';
import {
  proxyVariableName,
  requestsPerMinuteRange,
  unsupportedVariableNames,
  type Variable,
  variablePrefix,
  variables,
} from '@ecclium/mcp-churchtools-core';

const code = (text: string): string => `\`${text}\``;

const yesNo = (value: boolean): string => (value ? 'ja' : 'nein');

// What a value of each kind looks like. The table keeps no range of a
// number, so a second whole number would need its own text: the renderer
// refuses it instead of guessing.
const valuesOf = (variable: Variable): string => {
  switch (variable.kind) {
    case 'origin':
      return 'Adresse mit `https`';
    case 'path':
      return 'absoluter Pfad';
    case 'token':
      return 'Login-Token';
    case 'subject':
      return `Bezeichnung mit höchstens ${String(variable.maxLength)} Zeichen`;
    case 'boolean':
    case 'choice':
      return variable.choices.map(code).join(', ');
    case 'integer': {
      if (variable.name !== 'ECCLIUM_CHURCHTOOLS_REQUESTS_PER_MINUTE') {
        throw new TypeError(`no range known for ${variable.name}`);
      }
      const { min, max } = requestsPerMinuteRange;
      return `ganze Zahl von ${String(min)} bis ${String(max)}`;
    }
  }
};

/**
 * Renders the reference of the configuration: a table of every variable
 * in the order of the table of the core, a section with the description of
 * each, and the names that later versions reserve.
 *
 * @returns The Markdown of `docs/configuration.md`, ending with a line
 *   break.
 * @throws {TypeError} When a whole number other than the requests per
 *   minute appears, whose range the renderer does not know.
 * @example
 * ```ts
 * renderConfigurationReference().startsWith('# Konfiguration\n'); // true
 * ```
 */
export function renderConfigurationReference(): string {
  const lines = [
    '# Konfiguration',
    '',
    '<!-- Erzeugt mit `pnpm docs:generate` aus der Tabelle der Variablen. Nicht von Hand ändern. -->',
    '',
    'Diese Seite entsteht mit `pnpm docs:generate` aus der Tabelle der Variablen im Kern ([ADR 0055](adr/0055-konfiguration-identitaet.md)). Ein Test vergleicht sie mit dem Code. Ändern Sie sie deshalb nicht von Hand.',
    '',
    `Ecclium liest seine Konfiguration aus Variablen der Umgebung. Jede trägt das Präfix ${code(variablePrefix)}. Eine unbekannte oder falsch geschriebene Variable mit diesem Präfix bricht den Start ab. \`ecclium config check\` zeigt jede Einstellung mit ihrer Herkunft und prüft die Konfiguration, ohne ChurchTools anzufragen.`,
    '',
    '| Variable | Werte | Voreinstellung | Geheimnis | Nur über stdio |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const variable of variables) {
    const defaultValue =
      variable.defaultValue === undefined
        ? 'keine'
        : code(variable.defaultValue);
    lines.push(
      `| ${code(variable.name)} | ${valuesOf(variable)} | ${defaultValue} | ${yesNo(variable.secret)} | ${yesNo(variable.stdioOnly)} |`,
    );
  }
  for (const variable of variables) {
    lines.push(
      '',
      `## ${code(variable.name)}`,
      '',
      variableDescriptions[variable.name],
    );
  }
  lines.push(
    '',
    '## Noch nicht unterstützt',
    '',
    'Diese Namen gehören zu späteren Versionen. Ist einer gesetzt, bricht der Start mit einem Hinweis ab, statt die Variable still zu übergehen.',
    '',
    ...unsupportedVariableNames.map((name) => `- ${code(name)}`),
    `- ${code(proxyVariableName)}: Einen Proxy für ausgehende Verbindungen gibt es erst in einer späteren Version.`,
  );
  return `${lines.join('\n')}\n`;
}
