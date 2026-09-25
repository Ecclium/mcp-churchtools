# Sicherheit

## Eine Lücke melden

Melden Sie Sicherheitslücken bitte vertraulich über «Report a vulnerability» im Bereich «Security» dieses Repositorys (Private Vulnerability Reporting von GitHub). Eröffnen Sie dafür kein öffentliches Issue und keinen Pull Request.

Schicken Sie keine echten Daten mit: keine Hostnamen oder Tenant-Namen Ihrer ChurchTools-Instanz, keine Tokens, keine Personendaten. Beschreiben Sie das Problem mit Platzhaltern wie `https://example.church.tools`, `demo-tenant` oder `max.mustermann@example.org`. Wenn für die Analyse mehr nötig ist, fragen wir nach.

## Was Sie erwarten können

Ecclium wird von einer Person entwickelt. Es gibt keine Erreichbarkeit rund um die Uhr und keine Vertretung. Gerechnet ab Eingang Ihrer Meldung streben wir diese Fristen an:

| Schritt                  | Frist                  |
| ------------------------ | ---------------------- |
| Eingangsbestätigung      | innerhalb von 10 Tagen |
| Einschätzung der Meldung | innerhalb von 14 Tagen |
| Fix für kritische Lücken | innerhalb von 30 Tagen |

Nach dem Fix veröffentlichen wir einen Sicherheitshinweis (Security Advisory). Wenn Sie möchten, nennen wir Sie darin.

## Unterstützte Versionen

Bis Version 0.1.0 erschienen ist, gibt es nur den Stand auf `main`. Sicherheitskorrekturen gehen dorthin.

## Nicht hier melden

- Lücken in ChurchTools selbst melden Sie dem Hersteller von ChurchTools. Ecclium ist ein unabhängiges Projekt und steht in keiner Verbindung zum Hersteller von ChurchTools.
- Lücken in einer Abhängigkeit melden Sie dem Projekt, das sie pflegt. Betrifft eine solche Lücke Ecclium, sind wir für einen vertraulichen Hinweis dankbar.

## Bei einem Vorfall

Vermuten Sie einen Vorfall mit Ecclium, etwa ein abgeflossenes Token, eine kompromittierte Installation oder Abhängigkeit oder unerwartete Schreibvorgänge in ChurchTools, dann widerrufen Sie zuerst die ChurchTools-Tokens, die Ecclium benutzt, noch vor jeder Analyse. Ein Login-Token wirkt ohne zweiten Faktor und trägt alle Rechte seines Kontos.

## English

Please report vulnerabilities privately through GitHub's private vulnerability reporting ("Report a vulnerability" under "Security" in this repository), never in a public issue or pull request. Do not include real data such as host names, tenant names, tokens or personal data; use placeholders like `https://example.church.tools` instead. If we need more for the analysis, we will ask.

Ecclium is maintained by one person, without round-the-clock availability or a deputy. Counted from receipt of your report, we aim to acknowledge it within 10 days, assess it within 14 days and fix critical vulnerabilities within 30 days. Until version 0.1.0 is released, only `main` is supported.

After the fix we publish a security advisory and, if you wish, credit you in it. Report vulnerabilities in ChurchTools itself to the manufacturer of ChurchTools; Ecclium is an independent project and is not affiliated with the manufacturer of ChurchTools. Report vulnerabilities in a dependency to the project that maintains it.

If you suspect any incident involving Ecclium, such as a leaked token, a compromised installation or dependency, or unexpected write operations in ChurchTools, first revoke the ChurchTools tokens that Ecclium uses, before any analysis. A login token works without a second factor and carries all permissions of its account.
