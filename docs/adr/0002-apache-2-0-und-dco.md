# ADR 0002: Apache-2.0 und DCO, kein CLA, Kern bleibt offen

- Status: Vorgeschlagen
- Datum: 25.09.2026
- Fällt vor: Phase 0

## Kontext

Ecclium soll einen freien Kern haben, der für eine einzelne Gemeinde vollständig brauchbar ist. Funktionen für Organisationen sollen später als kostenpflichtiges Zusatzmodul dazukommen. Der Kern braucht deshalb eine Lizenz, die Betreibenden, Beitragenden und dem Projekt klare Rechte gibt, und eine Regel, unter der Beiträge von aussen angenommen werden. Gemeinden, die Ecclium einsetzen, müssen sich darauf verlassen können, dass der freie Kern frei bleibt.

Zu entscheiden sind zwei Fragen: Unter welcher Lizenz steht der Kern? Und wie bestätigen Beitragende, dass sie einen Beitrag einreichen dürfen?

## Optionen

Lizenz:

1. **MIT:** kurz und verbreitet, aber ohne ausdrückliche Patentlizenz und ohne Regel dafür, unter welcher Lizenz Beiträge eingehen.
2. **Apache License 2.0:** ebenso freizügig, dazu eine ausdrückliche Patentlizenz jedes Beitragenden. Sie erlischt für alle, die mit einer Klage geltend machen, das Werk verletze ein Patent (Abschnitt 3 der Lizenz). Beiträge gehen unter derselben Lizenz ein, sofern Beitragende nicht ausdrücklich etwas anderes erklären (Abschnitt 5). Enthält das Werk eine Datei `NOTICE`, müssen Weitergaben deren Hinweise mitführen, in einer eigenen Datei `NOTICE`, im Quelltext oder in der Dokumentation oder in einer Anzeige des Programms (Abschnitt 4 d).
3. **Copyleft wie GPL oder AGPL:** hält Weiterentwicklungen offen, erschwert aber Gemeinden und Dienstleistern die Verbindung mit eigener Software und passt nicht zu einem Zusatzmodul, das über eine veröffentlichte Schnittstelle geladen wird.

Beiträge:

1. **Contributor License Agreement (CLA):** Beitragende räumen dem Projekt weitergehende Rechte ein, oft bis zur Neulizenzierung ihrer Beiträge. Eine Hürde für Beitragende und ein Vertrauensproblem für ein Projekt mit kostenpflichtigem Zusatzmodul.
2. **Developer Certificate of Origin 1.1 (DCO):** Beitragende bestätigen mit einer Sign-off-Zeile im Commit, dass sie den Beitrag unter der Lizenz des Projekts einreichen dürfen. Das Projekt erhält keine weiteren Rechte.

## Entscheid

- Der Kern steht unter der Apache License 2.0.
- Beiträge kommen über das DCO 1.1. Jeder Commit in einem Pull Request trägt eine Zeile `Signed-off-by` mit Name und E-Mail-Adresse, passend zum Autor oder zur Autorin des Commits. Es gibt kein CLA.
- Das Sign-off nennt eine bekannte Identität. Ein Pseudonym genügt, wenn es dauerhaft zu einer Person gehört, etwa ein GitHub-Konto mit seiner noreply-Adresse. Anonyme Beiträge werden nicht angenommen.
- `NOTICE` nennt als Rechteinhaber «Die Autorinnen und Autoren von Ecclium».
- Name und Logo von Ecclium sind nicht Teil der Lizenz des Quellcodes. Ihren Gebrauch regelt `TRADEMARKS.md`.
- Die Zusage, dass nichts aus dem freien Kern hinter eine Bezahlschranke wandert, steht in `PROMISE.md`.

## Konsequenzen

- Jede veröffentlichte Fassung des Kerns bleibt unwiderruflich unter der Apache License 2.0 nutzbar (Abschnitt 2, für die Patentlizenz Abschnitt 3 mit seiner Ausnahme bei Patentklagen).
- Ohne CLA erhält das Projekt an Beiträgen keine Rechte, die über die Apache License 2.0 hinausgehen. Die Rechte an einem Beitrag bleiben bei seinen Autorinnen und Autoren.
- Die Lizenz allein hält künftige Fassungen nicht offen: Die Apache License 2.0 erlaubt, eine Weiterentwicklung unter anderen Bedingungen weiterzugeben (Abschnitt 4). Dass der Kern offen bleibt, sichert deshalb die ausdrückliche Zusage in `PROMISE.md`, nicht die Lizenz. Ecclium sagt das offen, statt mehr zu versprechen, als die Lizenz leistet.
- Fremder Quelltext wird nicht in den Kern übernommen, auch nicht unter MIT. Ist eine Ausnahme nötig, wird sie vorher entschieden, im Code markiert und in `NOTICE` mit Quelle und Lizenz vermerkt.
- Jeder Pull Request braucht eine Prüfung der Sign-offs. Bis eine automatische Prüfung besteht, prüfen die Maintainer von Hand.
- Die Sign-off-Zeile macht Name und E-Mail-Adresse dauerhaft öffentlich. `CONTRIBUTING.md` weist darauf hin und nennt die noreply-Adresse von GitHub als Ausweg.

## Umsetzung

- Lizenztext: `LICENSE`. Hinweise und Rechteinhaber: `NOTICE`.
- Zusage für den freien Kern: `PROMISE.md`.
- DCO im Wortlaut, Regeln für Sign-off und Identität: `CONTRIBUTING.md`.
