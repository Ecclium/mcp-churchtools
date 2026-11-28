/**
 * The German texts of `ecclium serve-http` (ADR 0073, ADR 0074). No text
 * names a token, a path or a message of the system: the path of a file
 * can hold the name of a user, and a message of the system names the
 * path.
 *
 * @packageDocumentation
 */
import type { HttpBindReason } from '@ecclium/mcp-churchtools-server/http';

import { formatNumber } from '../messages/index.js';

const address = '‹ECCLIUM_HTTP_ADDRESS›';
const port = '‹ECCLIUM_HTTP_PORT›';
const hosts = '‹ECCLIUM_ALLOWED_HOSTS›';
const file = '‹ECCLIUM_HTTP_TOKENS_FILE›';

/** Fixed texts of the start and the end. */
export const serveHttpTexts = Object.freeze({
  readOnly:
    'Der Server über HTTP liest nur. Schreiben über HTTP kommt mit einer späteren Version, bis dahin schreibt Ecclium nur im Betrieb über stdio.',
  noToken: `Die Datei aus ${file} hält kein Token, das heute gilt. Jede Anmeldung endet deshalb mit 401. Legen Sie mit ‹ecclium token create› ein Token an. Der Server liest die Datei bei jeder Anfrage neu, ein Neustart ist nicht nötig.`,
  signal:
    'Der Server über HTTP schliesst nach einem Signal. Laufende Anfragen enden noch, höchstens zehn Sekunden lang. Ein zweites Signal beendet ihn sofort.',
});

/**
 * How many tokens the file holds that hold today.
 *
 * @param valid - The tokens that hold today.
 * @param writing - How many of them have the scope `write`.
 * @returns One line for stderr.
 * @example
 * ```ts
 * tokensText(2, 1);
 * ```
 */
export function tokensText(valid: number, writing: number): string {
  const holds =
    valid === 1
      ? 'ein Token, das heute gilt'
      : `${formatNumber(valid)} Tokens, die heute gelten`;
  const scope =
    writing === 0
      ? ''
      : ` Davon ${writing === 1 ? 'hat eines' : `haben ${formatNumber(writing)}`} den Scope ‹write›, der über HTTP in dieser Version nichts freischaltet.`;
  return `Die Datei aus ${file} hält ${holds}.${scope}`;
}

/**
 * Where the server takes requests, once it listens. The address stands
 * here in clear, unlike in `ecclium config check`, whose output may go
 * into a public issue: the operator needs it to set up a client, and the
 * line goes only to the log of the operator.
 *
 * @param bound - The address it listens on, an IP address written out.
 * @param bound.address - The address.
 * @param bound.port - The port.
 * @returns One line for stderr with the address of MCP.
 * @example
 * ```ts
 * listeningText({ address: '127.0.0.1', port: 8765 });
 * ```
 */
export function listeningText(bound: {
  readonly address: string;
  readonly port: number;
}): string {
  const host = bound.address.includes(':')
    ? `[${bound.address}]`
    : bound.address;
  return `Der Server über HTTP nimmt Anfragen an ‹http://${host}:${String(bound.port)}/mcp› an, nur mit einem Bearer-Token. Beenden Sie ihn mit Ctrl+C oder SIGTERM.`;
}

/**
 * Why the server could not bind, with what to do.
 *
 * @param reason - The reason of the error of the binding.
 * @param code - The code of the system for `listen`, such as `EADDRINUSE`.
 * @returns One line for stderr.
 * @example
 * ```ts
 * bindText('listen', 'EADDRINUSE');
 * ```
 */
export function bindText(
  reason: HttpBindReason,
  code: string | undefined,
): string {
  switch (reason) {
    case 'address':
      return `Die Adresse aus ${address} ist keine ausgeschriebene IP-Adresse. Geben Sie etwa ‹127.0.0.1› oder ‹::1› an.`;
    case 'allowed-hosts':
      return `Die Adresse aus ${address} liegt ausserhalb von Loopback, aber ${hosts} ist nicht gesetzt. Setzen Sie die Namen, unter denen Clients den Server erreichen.`;
    case 'port':
      return `Der Port aus ${port} liegt ausserhalb von 1 bis 65'535.`;
    case 'listen':
      switch (code) {
        case 'EADDRINUSE':
          return `Der Port aus ${port} ist an dieser Adresse schon belegt, etwa durch einen zweiten Server. Beenden Sie den anderen Dienst oder wählen Sie einen anderen Port.`;
        case 'EACCES':
          return `Das System erlaubt diesem Benutzer den Port aus ${port} nicht, etwa einen Port unter 1'024. Wählen Sie einen höheren Port.`;
        case 'EADDRNOTAVAIL':
          return `Die Adresse aus ${address} gehört zu keiner Schnittstelle dieses Rechners. Prüfen Sie die Adresse.`;
        default:
          return `Der Server über HTTP konnte nicht an Adresse und Port binden. Ecclium zeigt keine Meldung des Systems, weil sie Pfade oder Namen nennen kann. Prüfen Sie ${address} und ${port}.`;
      }
  }
}
