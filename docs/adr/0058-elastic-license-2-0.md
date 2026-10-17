# ADR 0058: Elastic License 2.0 für das ganze Repository

- Status: Angenommen am 16.10.2026
- Datum: 16.10.2026
- Fällt vor: Phase 8

## Kontext

Seit dem ersten Commit am 25.09.2026 steht der Quellcode unter der Apache License 2.0, und Beiträge kommen über das Developer Certificate of Origin 1.1 (DCO), ohne Contributor License Agreement (CLA) (ADR 0002). Ecclium soll neben dem Betrieb durch die Gemeinde selbst auch als gehosteter Dienst angeboten werden (ADR 0013), und ein kostenpflichtiges Zusatzmodul soll über die veröffentlichte Schnittstelle laden (ADR 0015). Die Apache License 2.0 erlaubt jedem, den Kern als Dienst für andere zu betreiben. Noch ist kein Paket auf npm veröffentlicht: Alle Pakete sind `private` und tragen die Version 0.0.0. Zu entscheiden ist, unter welcher Lizenz der Quellcode vor dem ersten Release steht und unter welchen Bedingungen Beiträge eingehen.

Geprüft am 16.10.2026, Quellen ohne Host:

- **Elastic License 2.0 (ELv2), Abschnitte «Acceptance» bis «Definitions»:** Sie erlaubt, die Software zu nutzen, zu kopieren, weiterzugeben, verfügbar zu machen und Bearbeitungen herzustellen, mit drei Grenzen. Lizenznehmende dürfen die Software Dritten nicht als gehosteten oder verwalteten Dienst anbieten, der einen wesentlichen Teil ihrer Funktionen zugänglich macht. Sie dürfen die Funktion für Lizenzschlüssel nicht verschieben, ändern, abschalten oder umgehen und keine Funktionen entfernen, die sie schützt. Sie dürfen Hinweise des Lizenzgebers zu Lizenz und Urheberrecht nicht ändern oder entfernen. Wer die Software weitergibt, gibt die Bedingungen mit, und eine geänderte Fassung trägt einen deutlichen Hinweis darauf.
- **Lizenzgeber und Beendigung:** Lizenzgeber ist, wer die Bedingungen anbietet. Der Text hat keine Platzhalter für Namen oder Jahr. Die Patentlizenz kommt nur vom Lizenzgeber und deckt keine Ansprüche, die erst eigene Änderungen verletzen. Sie endet für die Person, die schriftlich geltend macht, die Software verletze ein Patent, und wenn ihre Firma das tut, für die Arbeit im Auftrag dieser Firma. Eine Nutzung gegen die Bedingungen beendet die Lizenzen der Person, die verstösst. Schickt der Lizenzgeber einen Hinweis und beendet sie jeden Verstoss innert 30 Tagen nach Erhalt, leben die Lizenzen rückwirkend wieder auf, ein weiterer Verstoss beendet sie endgültig. Zu einem Hinweis verpflichtet ist der Lizenzgeber nicht. Eine Regel für Beiträge wie Abschnitt 5 der Apache License 2.0 enthält die ELv2 nicht.
- **Einordnung:** Die SPDX-Kennung ist `Elastic-2.0` (SPDX License List 3.29). Die Open Source Initiative hat die ELv2 nicht anerkannt. Eine Grenze für das Anbieten als Dienst widerspricht dem sechsten Kriterium der Open Source Definition, keine Benachteiligung von Einsatzfeldern. Software unter der ELv2 heisst deshalb «source available», nicht Open Source. npm nimmt die Kennung im Feld `license` an. GitHub erkennt die ELv2 nicht und zeigt eine andere Lizenz an.
- **DCO 1.1:** Der Text darf nur unverändert weitergegeben werden. Er spricht viermal von einer «open source license».
- **Bisherige Fassungen:** Die Apache License 2.0 räumt ihre Rechte unwiderruflich ein (Abschnitt 2). Was bis zum Wechsel veröffentlicht ist, bleibt unter ihr nutzbar, auch für einen Betrieb als Dienst.
- **Beiträge bisher:** Auf `main` stammen alle Commits vom Maintainer oder von Renovate. Renovate hat nur Versionen und Prüfsummen in Manifesten, im Lockfile und in Workflows geändert.
- **Abhängigkeiten:** Code unter MIT, ISC und Apache-2.0 darf zusammen mit Code unter der ELv2 weitergegeben werden, wenn seine Lizenztexte und Hinweise mitgehen.

## Optionen

Lizenz:

1. **Apache License 2.0 behalten:** Open Source, für Beitragende und Firmen ohne Rückfrage verwendbar. Jeder darf den Kern aber als Dienst für andere betreiben, auch im Wettbewerb mit dem gehosteten Angebot von Ecclium, ohne etwas beizutragen.
2. **ELv2, nur `plugin-api` unter der Apache License 2.0:** schützt den Kern. Wer ein Plugin schreibt, bindet nur eine Open-Source-Schnittstelle ein. Dafür gelten im Repository zwei Lizenzen.
3. **ELv2 für das ganze Repository, `plugin-api` eingeschlossen:** eine Lizenz für alles, einfach zu prüfen. Wer ein Plugin schreibt, bindet eine Schnittstelle unter der ELv2 ein, die Scanner für Lizenzen markieren.
4. **Business Source License oder Server Side Public License:** Die BSL braucht ein Datum, ab dem eine Open-Source-Lizenz gilt, und eigene Parameter. Die SSPL verlangt, den ganzen Dienst offenzulegen, und ist auf Firmenlisten oft gesperrt.

Beiträge unter der ELv2:

1. **DCO, Beiträge unter der ELv2:** Der Wortlaut des DCO passt nicht. Vor allem hielte der Lizenzgeber beigetragenen Code nur unter der ELv2 und dürfte ihn selbst nicht als Dienst anbieten.
2. **DCO, Beiträge unter der Apache License 2.0, Weitergabe unter der ELv2:** Der Wortlaut des DCO passt vermutlich, weil Beiträge unter einer Open-Source-Lizenz eingehen, juristisch geprüft ist das nicht. Der Lizenzgeber erhält unter den Bedingungen von Abschnitt 4 der Apache License 2.0 die Rechte, die er für die Weitergabe unter der ELv2 und den eigenen Betrieb braucht. Die Patentlizenz jedes Beitragenden gilt für ihn selbst, unter der ELv2 weitergeben kann er sie nicht, weil Abschnitt 3 keine Unterlizenz kennt. Ein CLA ist nicht nötig.
3. **CLA:** üblich bei Projekten unter der ELv2 oder der BSL, gibt dem Projekt weitergehende Rechte. Eine Hürde für Beitragende, die ADR 0002 aus diesem Grund verworfen hatte.

## Entscheid

Gewählt sind die dritte Option zur Lizenz und die zweite Option zu Beiträgen.

- **Lizenz:** Der Quellcode im ganzen Repository steht unter der Elastic License 2.0, jedes Paket unter `packages/` eingeschlossen, auch `plugin-api` und `testkit`. `LICENSE` enthält den Text der ELv2 unverändert aus der Quelle, und das Feld `license` jedes Pakets lautet `Elastic-2.0`. Ausgenommen bleiben Name und Logo von Ecclium und Dateien, die eine eigene Lizenz nennen, etwa die Schriften in `brand/fonts/`.
- **Ab wann:** Die ELv2 gilt ab dem Commit, der sie einführt. Was vorher in diesem Repository veröffentlicht war, auch auf anderen Branches oder in Pull Requests, bleibt unter der Apache License 2.0 nutzbar. Ihr Text liegt in `LICENSES/Apache-2.0.txt`.
- **Lizenzgeber und Rechteinhaber:** Lizenzgeber ist, wer die ELv2 anbietet. `NOTICE` nennt die Rechteinhaber, vorerst mit der Sammelbezeichnung «Die Autorinnen und Autoren von Ecclium». Wer genau Lizenzgeber ist und wie `NOTICE` ihn nennt, klärt eine juristische Prüfung vor dem ersten Release. Die ELv2 erlaubt Lizenznehmenden nicht, den Quellcode Dritten als Dienst anzubieten. Der Lizenzgeber braucht dafür keine Lizenz und kann es anderen erlauben, soweit seine Rechte reichen.
- **Beiträge:** Jeder Commit in einem Pull Request trägt ein Sign-off nach dem DCO 1.1, unverändert. Beiträge gehen unter der Apache License 2.0 ein, und das Projekt gibt sie mit dem übrigen Quellcode unter der ELv2 weiter. Es gibt kein CLA. Vor dem ersten Beitrag von aussen prüft eine Juristin oder ein Jurist diese Regel und wie die Einräumung belegt wird. Bis dahin werden keine Beiträge von aussen gemergt, die mehr als Kleinigkeiten ändern.
- **Weiter wie bisher:** Für das Sign-off gilt eine bekannte Identität, ein dauerhaftes Pseudonym genügt, anonyme Beiträge werden nicht angenommen. Fremder Quelltext kommt nicht in den Kern. Ist eine Ausnahme nötig, wird sie vorher entschieden, im Code markiert und in `NOTICE` mit Quelle und Lizenz vermerkt. Name und Logo von Ecclium sind nicht Teil der Lizenz des Quellcodes, ihren Gebrauch regelt `TRADEMARKS.md`.
- **Zusage:** `PROMISE.md` bleibt. Was im kostenlosen Kern ist, wandert nicht hinter eine Bezahlschranke. «Freier Kern» heisst kostenlos nutzbar und selbst betreibbar, nicht Open Source.
- **Sprache:** Kein Text des Projekts nennt Ecclium Open Source oder quelloffen. Er sagt, dass der Quellcode öffentlich ist, und nennt die Lizenz.
- **Abgelöst:** Dieses ADR ersetzt ADR 0002. Dessen Zusage, der Kern bleibe offen, nimmt das Projekt damit zurück. Es tut das vor dem ersten Release, ohne Beiträge von aussen und drei Wochen nach der ersten Veröffentlichung. Es ersetzt auch die Aussage zur Lizenz des Kerns im Entscheid von ADR 0013 und die Konsequenz von ADR 0015, wer das Zusatzmodul mit dem Kern weitergebe, gebe den Kern unter der Apache License 2.0 weiter: Er gibt ihn unter der ELv2 weiter, mit `NOTICE`.

## Konsequenzen

- Eine Gemeinde darf Ecclium für sich selbst betreiben, auch auf einem Server, den eine helfende Person für sie einrichtet. Wer Ecclium Dritten als gehosteten oder verwalteten Dienst anbietet, etwa ein Dienstleister, eine Landeskirche oder eine freiwillige Person für eine oder mehrere andere Gemeinden, braucht eine Erlaubnis des Lizenzgebers. Ob eine Gemeinde, die ihre Instanz Mitarbeitenden und Freiwilligen öffnet, sie Dritten bereitstellt, und ob eine helfende Person Ecclium für eine einzige Gemeinde betreiben darf, klärt die Prüfung vor dem ersten Release.
- Ein Plugin darf `plugin-api` einbinden und für seinen eigenen Code eine eigene Lizenz wählen. Wer eine Kopie von `plugin-api` weitergibt, gibt die ELv2 mit. Scanner für Lizenzen und Positivlisten von Firmen markieren `Elastic-2.0`, auch bei Autorinnen und Autoren von Plugins.
- Die Grenze zum Lizenzschlüssel schützt die Prüfung signierter Lizenzen aus ADR 0008, sobald es sie gibt: die öffentlichen Schlüssel, die Prüfung und die Stufe der Pipeline, die Funktionen des Zusatzmoduls freischaltet. Wer sie entfernt, verstösst gegen die ELv2, auch in einer eigenen Fassung. Keine Funktion des freien Kerns hängt an einer Lizenz (ADR 0008).
- Die ELv2 nennt ihre Rechte nicht unwiderruflich. Ein Verstoss beendet die Lizenzen der Person, die verstösst. Sie leben nur wieder auf, wenn der Lizenzgeber einen Hinweis schickt und der Verstoss innert 30 Tagen endet. Die Patentlizenz kommt nur vom Lizenzgeber. Für künftige Fassungen verspricht `PROMISE.md` mehr als die Lizenz: Was im freien Kern ist, bleibt dort.
- Ecclium ist nicht mehr Open Source. Das Abzeichen der OpenSSF Best Practices setzt Open Source voraus und ist nicht erreichbar, die Prüfung «License» von Scorecard verliert vermutlich einen Punkt, und GitHub zeigt keine erkannte Lizenz.
- Abhängigkeiten unter MIT, ISC und Apache-2.0 bleiben erlaubt, die Liste in `scripts/check-licenses.mts` ändert sich nicht. Jedes veröffentlichte Paket und jedes Image trägt `LICENSE`, `NOTICE`, den Text der Apache License 2.0 und die Hinweise der gebündelten Abhängigkeiten.
- Mit der ELv2 entfallen die Erleichterungen für freie und quelloffene Software im Cyber Resilience Act (Verordnung (EU) 2024/2847) und in der Produkthaftungsrichtlinie (Richtlinie (EU) 2024/2853). Wegen des gehosteten Dienstes und des Zusatzmoduls wäre der Kern vermutlich auch unter der Apache License 2.0 erfasst. Welche Pflichten ab dem ersten Release gelten, klärt die Prüfung davor.
- Die Texte der ELv2 und des DCO sind englisch. Nur der englische Text gilt.
- **Restrisiken:**
  - **Fassung unter Apache:** Jeder darf den Stand vor dem Wechsel als eigene Fassung unter der Apache License 2.0 weiterführen, auch als Dienst. Er enthält noch keine Prüfung von Lizenzen.
  - **Beiträge:** Ob Beiträge unter der Apache License 2.0 und ein unverändertes DCO den Lizenzgeber ausreichend absichern, ist juristisch nicht geprüft. Beigetragene Teile bleiben für alle unter der Apache License 2.0 nutzbar, auch als Dienst, aber nur diese Teile. An Beiträgen hält der Lizenzgeber nur eine einfache Lizenz und kann Verstösse daran nicht allein verfolgen. Ob Empfänger unter der ELv2 die Patentlizenzen der Beitragenden erhalten, ist offen.
  - **Renovate:** Dass die Commits von Renovate als rein technische Änderungen keine Rechte begründen, ist eine Annahme, juristisch nicht geprüft.
  - **Lizenzgeber:** Eine Sammelbezeichnung als Rechteinhaber macht unklar, wer Verstösse abmahnt und Erlaubnisse erteilt.

## Umsetzung

- Text der Apache License 2.0 für frühere Fassungen und Beiträge: `LICENSES/Apache-2.0.txt`, unverändert aus der früheren `LICENSE`.
- Lizenztext: `LICENSE`, der Text der ELv2 unverändert aus dem Repository von Elasticsearch, `licenses/ELASTIC-LICENSE-2.0.txt`, geholt am 16.10.2026, SHA-256 `48255018b41fc0e965b1115af7e6779bc218bb8a6747d561da800d5022622aa2`. Hinweise und Rechteinhaber: `NOTICE`. Zusage: `PROMISE.md`. Beiträge und DCO: `CONTRIBUTING.md`. Kurzfassung für Betreibende: `README.md`, Abschnitt «Lizenz».
- Lizenzfeld jedes Pakets: `packages/*/package.json`. `tests/packages.test.mts` prüft, dass jedes Paket `Elastic-2.0` nennt.
- Prüfung des Sign-offs wie bisher: `scripts/ci/check-dco.mts`, im Git-Hook (`lefthook.yml`) und im Job `dco` (`.github/workflows/pr-meta.yml`).
- Pull Requests: Die Vorlage fragt nach der Bestätigung, dass ein Beitrag unter der Apache License 2.0 eingeht.
- Offen: die juristische Prüfung der Regel für Beiträge vor dem ersten Beitrag von aussen und die Klärung von Lizenzgeber, Lizenz der übrigen Dateien in `brand/`, Cyber Resilience Act und Produkthaftung vor dem ersten Release (`docs/STATUS.md`, Offen).
- Offen: dass jedes Tarball und jedes Image `LICENSE`, `NOTICE` und `LICENSES/Apache-2.0.txt` enthält, geprüft am gepackten Tarball im Release-Pfad (ADR 0040).
