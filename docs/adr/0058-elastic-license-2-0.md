# ADR 0058: Elastic License 2.0 für das ganze Repository

- Status: Vorgeschlagen
- Datum: 16.10.2026
- Fällt vor: Phase 8

## Kontext

Seit dem ersten Commit am 25.09.2026 steht der Quellcode unter der Apache License 2.0, und Beiträge kommen über das Developer Certificate of Origin 1.1 (DCO), ohne Contributor License Agreement (CLA) (ADR 0002). Ecclium soll neben dem Betrieb durch die Gemeinde selbst auch als gehosteter Dienst angeboten werden (ADR 0013), und ein kostenpflichtiges Zusatzmodul soll über die veröffentlichte Schnittstelle laden (ADR 0015). Die Apache License 2.0 erlaubt jedem, den Kern als Dienst für andere zu betreiben. Noch ist kein Paket auf npm veröffentlicht: Alle Pakete sind `private` und tragen die Version 0.0.0. Zu entscheiden ist, unter welcher Lizenz der Quellcode vor dem ersten Release steht und unter welchen Bedingungen Beiträge eingehen.

Geprüft am 16.10.2026, Quellen ohne Host:

- **Elastic License 2.0 (ELv2), Abschnitte «Acceptance» bis «Definitions»:** Sie erlaubt, die Software zu nutzen, zu kopieren, weiterzugeben, verfügbar zu machen und Bearbeitungen herzustellen, mit drei Grenzen. Niemand darf die Software Dritten als gehosteten oder verwalteten Dienst anbieten, der einen wesentlichen Teil ihrer Funktionen zugänglich macht. Niemand darf die Funktion für Lizenzschlüssel verschieben, ändern, abschalten oder umgehen oder Funktionen entfernen, die sie schützt. Niemand darf Hinweise des Lizenzgebers zu Lizenz und Urheberrecht ändern oder entfernen. Wer die Software weitergibt, gibt die Bedingungen mit, und eine geänderte Fassung trägt einen deutlichen Hinweis darauf.
- **Lizenzgeber und Beendigung:** Lizenzgeber ist, wer die Bedingungen anbietet. Der Text hat keine Platzhalter für Namen oder Jahr. Die Patentlizenz kommt nur vom Lizenzgeber und endet, sobald jemand schriftlich geltend macht, die Software verletze ein Patent. Eine Nutzung gegen die Bedingungen beendet alle Lizenzen. Endet der Verstoss innert 30 Tagen nach einem Hinweis des Lizenzgebers, leben sie rückwirkend wieder auf, ein weiterer Verstoss beendet sie endgültig. Eine Regel für Beiträge wie Abschnitt 5 der Apache License 2.0 enthält die ELv2 nicht.
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
2. **DCO, Beiträge unter der Apache License 2.0, Weitergabe unter der ELv2:** Der Wortlaut des DCO passt, weil Beiträge unter einer Open-Source-Lizenz eingehen. Der Lizenzgeber erhält alle Rechte, die er für die Weitergabe unter der ELv2 und den eigenen Betrieb braucht, dazu die Patentlizenz jedes Beitragenden. Ein CLA ist nicht nötig.
3. **CLA:** üblich bei Projekten unter der ELv2 oder der BSL, gibt dem Projekt weitergehende Rechte. Eine Hürde für Beitragende, die ADR 0002 aus diesem Grund verworfen hatte.

## Entscheid

Gewählt sind die dritte Option zur Lizenz und die zweite Option zu Beiträgen.

- **Lizenz:** Das ganze Repository steht unter der Elastic License 2.0, jedes Paket unter `packages/` eingeschlossen, auch `plugin-api` und `testkit`. `LICENSE` enthält den Text der ELv2 unverändert aus der Quelle, und das Feld `license` jedes Pakets lautet `Elastic-2.0`. Ausgenommen bleiben Dateien, die eine eigene Lizenz nennen, etwa die Schriften in `brand/fonts/`.
- **Ab wann:** Die ELv2 gilt ab dem Commit, der sie einführt. Alles, was vorher auf `main` lag, bleibt unter der Apache License 2.0 nutzbar.
- **Lizenzgeber:** `NOTICE` nennt ihn als Rechteinhaber. Nur er darf den Quellcode selbst als Dienst anbieten oder anderen das erlauben.
- **Beiträge:** Jeder Commit in einem Pull Request trägt ein Sign-off nach dem DCO 1.1, unverändert. Beiträge gehen unter der Apache License 2.0 ein, und das Projekt gibt sie mit dem übrigen Quellcode unter der ELv2 weiter. Es gibt kein CLA. Vor dem ersten Beitrag von aussen prüft eine Juristin oder ein Jurist diese Regel.
- **Weiter wie bisher:** Für das Sign-off gilt eine bekannte Identität, ein dauerhaftes Pseudonym genügt, anonyme Beiträge werden nicht angenommen. Fremder Quelltext kommt nicht in den Kern. Ist eine Ausnahme nötig, wird sie vorher entschieden, im Code markiert und in `NOTICE` mit Quelle und Lizenz vermerkt. Name und Logo von Ecclium sind nicht Teil der Lizenz des Quellcodes, ihren Gebrauch regelt `TRADEMARKS.md`.
- **Zusage:** `PROMISE.md` bleibt. Was im kostenlosen Kern ist, wandert nicht hinter eine Bezahlschranke. «Freier Kern» heisst kostenlos nutzbar und selbst betreibbar, nicht Open Source.
- **Sprache:** Kein Text des Projekts nennt Ecclium Open Source oder quelloffen. Er sagt, dass der Quellcode öffentlich ist, und nennt die Lizenz.
- **Abgelöst:** Dieses ADR ersetzt ADR 0002. Es ersetzt auch die Aussage zur Lizenz des Kerns im Entscheid von ADR 0013 und die Konsequenz von ADR 0015, wer das Zusatzmodul mit dem Kern weitergebe, gebe den Kern unter der Apache License 2.0 weiter: Er gibt ihn unter der ELv2 weiter, mit `NOTICE`.

## Konsequenzen

- Eine Gemeinde darf Ecclium für sich selbst betreiben, auch auf einem Server, den eine helfende Person für sie einrichtet. Wer Ecclium für andere Gemeinden betreibt, ein Dienstleister, eine Landeskirche oder eine freiwillige Person für mehrere Gemeinden, braucht eine eigene Erlaubnis des Lizenzgebers.
- Ein Plugin darf `plugin-api` einbinden und für seinen eigenen Code eine eigene Lizenz wählen. Wer eine Kopie von `plugin-api` weitergibt, gibt die ELv2 mit. Scanner für Lizenzen und Positivlisten von Firmen markieren `Elastic-2.0`, auch bei Autorinnen und Autoren von Plugins.
- Die Grenze zum Lizenzschlüssel schützt die Prüfung signierter Lizenzen aus ADR 0008, sobald es sie gibt: die öffentlichen Schlüssel, die Prüfung und die Stufe der Pipeline, die Funktionen des Zusatzmoduls freischaltet. Wer sie entfernt, verstösst gegen die ELv2, auch in einer eigenen Fassung. Keine Funktion des freien Kerns hängt an einer Lizenz (ADR 0008).
- Die ELv2 nennt ihre Rechte nicht unwiderruflich. Ein Verstoss beendet sie, mit 30 Tagen, um ihn zu beheben. Die Patentlizenz kommt nur vom Lizenzgeber. `PROMISE.md` verspricht deshalb nichts, was die ELv2 nicht trägt.
- Ecclium ist nicht mehr Open Source. Das Abzeichen der OpenSSF Best Practices setzt Open Source voraus und ist nicht erreichbar, die Prüfung «License» von Scorecard verliert vermutlich einen Punkt, und GitHub zeigt keine erkannte Lizenz.
- Abhängigkeiten unter MIT, ISC und Apache-2.0 bleiben erlaubt, die Liste in `scripts/check-licenses.mts` ändert sich nicht. Jedes veröffentlichte Paket und jedes Image trägt `LICENSE` und `NOTICE` und die Hinweise der gebündelten Abhängigkeiten.
- Die Texte der ELv2 und des DCO sind englisch. Nur der englische Text gilt.
- **Restrisiken:**
  - **Fassung unter Apache:** Jeder darf den Stand vor dem Wechsel als eigene Fassung unter der Apache License 2.0 weiterführen, auch als Dienst. Er enthält noch keine Prüfung von Lizenzen.
  - **Beiträge:** Ob Beiträge unter der Apache License 2.0 und ein unverändertes DCO den Lizenzgeber ausreichend absichern, ist juristisch nicht geprüft.
  - **Renovate:** Dass die Commits von Renovate als rein technische Änderungen keine Rechte begründen, ist eine Annahme, juristisch nicht geprüft.
  - **Lizenzgeber:** Eine Sammelbezeichnung als Rechteinhaber macht unklar, wer Verstösse abmahnt und Erlaubnisse erteilt.
