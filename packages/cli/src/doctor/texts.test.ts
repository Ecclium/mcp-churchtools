import { describe, expect, it } from 'vitest';

import type { AccountCheck } from './accounts.js';
import type { EgressCheck } from './egress.js';
import {
  accountsSection,
  egressSection,
  providerUseText,
  resultText,
  routinesCountText,
} from './texts.js';

// The texts of ecclium doctor for cases its test over real folders does
// not reach. All data are made up.

const target = (roles: readonly string[], host = 'demo.example') => ({
  host,
  port: '443',
  lan: false,
  roles,
});

const account = (rights: AccountCheck['rights']): AccountCheck => ({
  credential: 'berichte',
  routines: ['wochen-bericht'],
  refused: [],
  rights,
});

describe('the texts of ecclium doctor', () => {
  it('report a target with several roles, a refusal with a status and a failed handshake', () => {
    const check: EgressCheck = {
      kind: 'checked',
      targets: [
        {
          target: target(['ChurchTools', 'Anbieter ‹default›']),
          probe: { ok: false, reason: 'refused', status: 502 },
        },
        {
          target: target(['Ping des Runners'], 'ping.example'),
          probe: { ok: false, reason: 'tls' },
        },
        {
          target: target(['Anbieter ‹reserve›'], 'reserve.example'),
          probe: { ok: false, reason: 'refused', status: 403 },
        },
      ],
      outside: { ok: false, reason: 'no_answer' },
      direct: { connected: false, reason: 'no_connection' },
    };
    const { lines, findings } = egressSection(check, false);
    expect(lines).toContain(
      '  Befund: ChurchTools und Anbieter ‹default›: Der Proxy gibt keinen Tunnel, Status 502. Bei 502 oder 503 erreicht er das Ziel nicht, etwa weil sein Name nicht auflöst.',
    );
    expect(lines).toContain(
      '  Befund: Ping des Runners: Der Proxy gibt den Tunnel, aber TLS mit dem Ziel scheitert. Das Zertifikat ist nicht vertraut oder lautet auf einen anderen Namen, das Ziel spricht kein TLS, oder etwas auf dem Weg bricht TLS auf.',
    );
    // Only some targets refused with 403: the list is one of another
    // configuration.
    expect(lines).toContain(
      '  Die Ziele mit 403 fehlen in der Liste des Proxys, sie stammt wohl aus einer anderen Konfiguration. Erzeugen Sie sie mit ‹ecclium init egress› aus dieser Konfiguration neu und ersetzen Sie die Datei.',
    );
    expect(lines).toContain(
      '  Befund: Auf den Tunnel zu ‹ecclium-doctor.invalid›, einem Namen ausserhalb jeder Liste, antwortet der Proxy nicht mit 403.',
    );
    expect(findings).toBe(4);
  });

  it('report a proxy that answers no tunnel', () => {
    const { lines } = egressSection(
      {
        kind: 'checked',
        targets: [
          {
            target: target(['ChurchTools']),
            probe: { ok: false, reason: 'no_answer' },
          },
        ],
        outside: undefined,
        direct: { connected: false, reason: 'timeout' },
      },
      false,
    );
    expect(lines).toContain(
      '  Direkt, ohne den Proxy, kommt in 10 Sekunden keine Verbindung zu ChurchTools zustande, so wenig wie für den Runner mit derselben Frist. Ob schon der Name nicht auflöste, zeigt das nicht.',
    );
    expect(lines).toContain(
      '  Befund: ChurchTools: Der Proxy nimmt die Verbindung an, gibt aber in der Frist keine Antwort auf den Tunnel. Er erreicht das Ziel womöglich nicht, oder er antwortet selbst nicht.',
    );
  });

  it.each([
    [
      ['Anbieter ‹lokal›'],
      '  Befund: Anbieter ‹lokal› hat einen anderen Port als 443 und steht nicht in ‹ECCLIUM_EGRESS_ALLOW_LAN›. Die Vorlage für Squid liesse es nie durch, darum prüft ‹ecclium doctor› den Weg nicht. Liegt das Ziel im lokalen Netz, nehmen Sie Name und Port in ‹ECCLIUM_EGRESS_ALLOW_LAN› auf.',
    ],
    [
      ['ChurchTools', 'Anbieter ‹lokal›'],
      '  Befund: ChurchTools, Anbieter ‹lokal› haben einen anderen Port als 443 und stehen nicht in ‹ECCLIUM_EGRESS_ALLOW_LAN›. Die Vorlage für Squid liesse sie nie durch, darum prüft ‹ecclium doctor› den Weg nicht. Liegt das Ziel im lokalen Netz, nehmen Sie Name und Port in ‹ECCLIUM_EGRESS_ALLOW_LAN› auf.',
    ],
  ])('report targets the template never lets through: %j', (roles, line) => {
    expect(egressSection({ kind: 'ports', roles }, false)).toEqual({
      lines: ['Ausgehender Weg:', line],
      findings: 1,
    });
  });

  it('report an account whose token file or rights could not be used', () => {
    expect(
      accountsSection([account({ kind: 'account', code: 'token_file_mode' })])
        .lines,
    ).toContain(
      '    Befund: Das Token des Kontos lässt sich nicht verwenden, Code ‹token_file_mode›. Prüfen Sie die Datei ‹ct_token_<Alias>› im Ordner aus ‹ECCLIUM_RUNNER_TOKENS_DIR›: Sie muss vorhanden sein, Ihrem Benutzer gehören und die Rechte 600 haben.',
    );
    expect(
      accountsSection([account({ kind: 'failed', code: 'upstream' })]).lines,
    ).toContain(
      '    Befund: Die Rechte liessen sich nicht lesen, Fehler ‹upstream›. Diesen Fehler gibt es auch, wenn das Konto mehr als 150 gesetzte Rechte hat. Ein Konto des Runners braucht nur die Rechte seiner Routinen.',
    );
    expect(
      accountsSection([account({ kind: 'failed', code: 'network' })]).lines,
    ).toContain(
      '    Befund: Die Rechte liessen sich nicht lesen, Fehler ‹network›. Ecclium erreichte ChurchTools nicht, mit einem Proxy auch nicht durch ihn.',
    );
    expect(
      accountsSection([account({ kind: 'failed', code: 'internal' })]).lines,
    ).toContain(
      '    Befund: Die Rechte liessen sich nicht lesen, Fehler ‹internal›.',
    );
  });

  it('report a list of categories ct_whoami cut short as not judged whole, and its exception without advice to remove it', () => {
    const { lines, findings } = accountsSection([
      account({
        kind: 'judged',
        rights: {
          beyond: [],
          missing: [],
          exceptions: [
            {
              routine: 'wochen-bericht',
              until: '2026-11-19' as never,
              holds: true,
            },
          ],
        },
        cut: true,
      }),
    ]);
    expect(lines).toContain(
      '    Befund: Das Konto darf in mehr als 10 Kategorien des Wikis schreiben. ‹ct_whoami› nennt nur die ersten 10, darum prüft ‹ecclium doctor› das Recht ‹edit category› nicht ganz.',
    );
    expect(lines).toContain(
      '    Die Ausnahme ‹acceptRightsDrift› der Routine ‹wochen-bericht› gilt bis 19.11.2026: Ihre Läufe schreiben trotz zu weiter Rechte.',
    );
    expect(findings).toBe(1);
  });

  it('report rights the routines need and the account lacks', () => {
    const { lines, findings } = accountsSection([
      account({
        kind: 'judged',
        rights: {
          beyond: [],
          missing: [{ module: 'churchservice', right: 'view' }],
          exceptions: [],
        },
        cut: false,
      }),
    ]);
    expect(lines).toContain(
      '    Befund: Rechte, die seine Routinen brauchen und die ‹ct_whoami› nicht zeigt: ‹churchservice› ‹view›. Ein Schreibvorgang scheitert dann am Recht, und ein Lesen liefert womöglich weniger oder nichts. Rechte aus einer Gruppe zeigt ‹ct_whoami› womöglich nicht.',
    );
    expect(findings).toBe(1);
  });

  it('count routines, findings and providers in words', () => {
    expect(routinesCountText(1, 0)).toBe(
      'Routinen: 1 startet, 0 starten nicht.',
    );
    expect(routinesCountText(1_200, 2)).toBe(
      "Routinen: 1'200 starten, 2 starten nicht.",
    );
    expect(resultText(1, 0)).toBe(
      'Ergebnis: 1 Befund zu Weg, Anbietern, Routinen und Konten.',
    );
    expect(resultText(0, 0)).toBe(
      'Ergebnis: kein Befund zu Weg, Anbietern, Routinen und Konten.',
    );
    expect(providerUseText('default', ['a', 'b'])).toBe(
      '‹default›: genutzt von ‹a›, ‹b›.',
    );
  });
});
