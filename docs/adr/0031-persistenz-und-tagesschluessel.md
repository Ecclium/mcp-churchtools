# ADR 0031: Ausnahmen der Persistenz und Crypto-Shredding mit Tagesschlüsseln

- Status: Vorgeschlagen
- Datum: 03.11.2026
- Fällt vor: Phase 5
- Ergänzt: [ADR 0029](0029-write-guard.md) (Rücknahme) und [ADR 0069](0069-stufe-strict.md) (Port für Schlüssel)

## Kontext

Ecclium hält keine Daten der Gemeinde, ausser in wenigen benannten Ausnahmen, die [`docs/privacy.md`](../privacy.md) beschreibt. Mit dem Schreiben in Phase 5 kommen zwei dazu, die Inhalte tragen: der Snapshot, also der Stand eines Ziels vor einem Schreibvorgang, und die Freigabe-Warteschlange mit vorgeschlagenen Inhalten. Die Audit-Datei regelt [ADR 0028](0028-audit-ereignis-und-datei-sink.md), sie trägt keine Inhalte.

- **Rücknahme:** Nach [ADR 0029](0029-write-guard.md) lassen sich alle sechs Schreib-Tools des Kerns zurücknehmen. Vor dem Ändern und Anhängen sichert der Kern den vorigen Stand, und `ecclium undo` nimmt einen Schreibvorgang über die Kennung seines Ereignisses im Audit zurück. Sind Snapshots abgeschaltet, lässt sich nichts zurücknehmen, und das Echo lehnt jeden Plan ab.
- **Grundsatzentscheid 5** ([`docs/STATUS.md`](../STATUS.md)): Snapshots sind standardmässig an, bleiben 30 Tage, lassen sich abschalten, sind mit Tagesschlüsseln verschlüsselt und werden nach der Frist und einem Tag vernichtet.
- **Sicherungen:** Ein Zustandsordner liegt oft in einer Sicherung, über stdio auf einem Mac etwa in Time Machine. Ein Snapshot, den der Server nach 30 Tagen löscht, bliebe dort lesbar ([Threat Model](../threat-model.md), T15).
- **Zwei Arten Schlüssel:** Die Pseudonyme der Stufe `strict` kommen aus einer Schlüsseldatei des Betreibers, die gesichert wird, damit ein Pseudonym zurückkommt ([ADR 0069](0069-stufe-strict.md)). Für Snapshots gilt das Gegenteil: Nach der Frist soll niemand sie mehr lesen können, auch nicht aus einer Sicherung.
- **Zwei Prozesse:** Über stdio teilen sich Clients denselben Zustandsordner, etwa Claude Desktop und Claude Code ([ADR 0029](0029-write-guard.md), Konsequenzen).

## Optionen

Für den Schutz:

1. **Snapshots ohne Verschlüsselung**, gelöscht nach der Frist. Jede Kopie in einer Sicherung bleibt lesbar, solange die Sicherung besteht.
2. **Ein Schlüssel je Frist**, etwa für 30 Tage. Ein Snapshot vom ersten Tag eines Schlüssels bliebe bis zu 60 Tage lesbar.
3. **Ein Schlüssel je Tag** in einem eigenen Ordner ohne Sicherung, vernichtet nach der Frist und einem Tag. Mit dem Schlüssel wird jeder Snapshot seines Tages unlesbar, in jeder Kopie (Crypto-Shredding).

Für den Ort der Schlüssel: ein Unterordner des Zustandsordners, mit weniger Einrichtung, aber in derselben Sicherung wie die Snapshots, oder ein eigener Ordner.

Für das Anlegen durch zwei Prozesse: eine Sperrdatei wie beim `QuotaStore` ([ADR 0063](0063-quotastore-als-datei.md)) oder eine Datei, die nur einmal entsteht.

## Entscheid

Gewählt ist die dritte Option, mit einem eigenen Ordner, entschieden am 01.11.2026 mit dem Plan für Phase 5, und den Einzelheiten unten, entschieden am 02.11.2026.

### Ausnahmen der Persistenz

| Ausnahme               | Inhalt                                                        | Frist                                                  | Schutz                                                                                                 |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Snapshots              | vorheriger Stand des betroffenen Felds, kein ganzer Datensatz | 30 Tage, abschaltbar                                   | AES-256-GCM, Schlüssel mit dem Tagesschlüssel verschlüsselt, Vernichtung des Tagesschlüssels an Tag 31 |
| Freigabe-Warteschlange | vorgeschlagene Inhalte und Unterschiede                       | 14 Tage, höchstens 30                                  | wie Snapshots, mit Tagesschlüsseln eigenen Zwecks                                                      |
| Audit-Datei            | Ereignisse ohne Inhalte, mit Kennungen von Objekten           | nach [ADR 0028](0028-audit-ereignis-und-datei-sink.md) | nach [ADR 0028](0028-audit-ereignis-und-datei-sink.md)                                                 |
| Ausgabeziel `file`     | Entwürfe einer Routine, ab Phase 6                            | Sache des Betreibers                                   | Hinweis in der Doku                                                                                    |

Der `PlanStore` trägt Inhalte und liegt deshalb nur im Arbeitsspeicher ([ADR 0029](0029-write-guard.md)). Der `QuotaStore` trägt nur Zähler und ist keine Ausnahme, `docs/privacy.md` nennt ihn trotzdem.

### Tagesschlüssel

- **Was:** 32 zufällige Bytes je Mandant, Zweck und UTC-Tag. Zwecke sind `snapshot` und `queue`. Über stdio heisst der Mandant immer `default`.
- **Wo:** `<ECCLIUM_KEYS_DIR>/<Zweck>/<Mandant>.<Tag>.key`, 64 Zeichen Hex, Datei 0600, Ordner 0700. `ECCLIUM_KEYS_DIR` ist Pflicht, sobald der Server schreibt (`ECCLIUM_READ_ONLY=false`). Der Ordner wird geprüft wie der Zustandsordner, darf nicht der Zustandsordner sein, nicht darin liegen und ihn nicht enthalten, und wird nie gesichert. Enthielte er ihn, könnte der Ordner eines Zwecks der Zustandsordner selbst sein, und wer den Ordner der Schlüssel aus der Sicherung nimmt, nähme das Audit mit heraus. Fehlt er oder passt er nicht, bricht der Start mit 78 ab. Die Anleitung zeigt, wie er aus Time Machine bleibt (`tmutil addexclusion`). Im Container ist es ein eigenes Volume `keys`.
- **Entstehen:** beim ersten Gebrauch eines Tages, einmal: ganz unter einem temporären Namen geschrieben, mit `fsync` auf die Platte gebracht und erst dann mit `link` unter seinen Namen gestellt, was scheitert, wenn der Name vergeben ist. Zwei Prozesse, die am selben neuen Tag zugleich einen Snapshot sichern, enden so mit demselben Schlüssel, der zweite liest den des ersten. Eine Sperrdatei braucht das nicht, weil die Datei nie wieder geändert wird. Die Sperrdatei kommt mit der Freigabe-Warteschlange, deren Einträge sich ändern.
- **Vernichten:** Nullen über die ganze Datei, `fsync`, dann der Name entfernt, auch ein temporärer Name, den ein Schreiber beim Abbruch zurückliess. Gibt es eine zweite Verknüpfung derselben Datei, enthält sie danach nur Nullen. Lässt sich eine Datei nicht beschreiben oder hat sie andere Rechte bekommen, verliert sie ihren Namen trotzdem, denn gerade eine Datei, die andere lesen können, muss weg. Ein Link oder eine FIFO unter dem Namen eines Schlüssels verliert nur den Namen. Bleibt ein Eintrag stehen, etwa ein Ordner unter dem Namen eines Schlüssels, vernichtet der Server alle übrigen und meldet ihn danach, damit ein einzelner schlechter Eintrag nie alle späteren Schlüssel am Leben hält. Vernichtet werden die Tage vor dem Tag, der die Frist beginnt: Ein Snapshot vom Tag T ist bis zum Tag T plus 30 lesbar, an Tag 31 nicht mehr. Der Server vernichtet beim Start, vor jedem Snapshot und mit dem Zeitgeber des Tages, auch ohne einen Aufruf.
- **Port:** Der `KeyProvider` der Schnittstelle für Plugins hat neben `dataKeys` für die Pseudonyme `wrap`, `unwrap` und `destroyBefore` für die Tagesschlüssel. Er gibt einen Tagesschlüssel nie heraus, er verschlüsselt mit ihm nur einen Schlüssel von 32 Bytes und öffnet ihn wieder, nur für denselben Mandanten, Zweck und Tag. Für einen vernichteten Tag gibt `unwrap` nichts zurück, für einen veränderten Wert verwirft es. So kann ein Plugin die Tagesschlüssel später in einem eigenen Dienst halten. Im Speicher stehen Schlüssel nur als Bytes, die nach dem Gebrauch gelöscht werden, nie als Text.

### Snapshots

- **Verschlüsselung:** Jeder Snapshot bekommt einen eigenen zufälligen Schlüssel. Mit ihm verschlüsselt AES-256-GCM aus `node:crypto` den Inhalt, mit 12 Bytes Nonce und als zusätzlichen Daten Format, Kennung des Ereignisses, Mandant, Instanz, Ziel und Tag, damit sich kein Inhalt in einen anderen Eintrag verschieben lässt. Den Schlüssel verschlüsselt der `KeyProvider` mit dem Tagesschlüssel.
- **Ablage:** ein Port `SnapshotStore` in der Schnittstelle für Plugins, der nur verschlüsselte Einträge sieht, mit Prüfungen in `testkit`. Im freien Kern unter `<ECCLIUM_STATE_DIR>/snapshots/<Tag>/<Kennung>.snapshot`, ein Ordner je UTC-Tag, damit die Löschung nach der Frist ganze Tage nimmt.
- **Inhalt:** nur das betroffene Feld. Beim Ändern und Anhängen der Text vor dem Schreiben mit seiner Version, dazu die Version und der Hash des geschriebenen Texts. Bei einer neuen Seite Kategorie, Titel und Hash des Texts, nach dem Lesen danach ergänzt um GUID und Version. Die Kennung ist die `eventId` der Zeile im Audit, die den Schreibvorgang festhält.
- **Zeitpunkt:** im Festschreiben nach Nachweis, Uhr und Richtlinie, unmittelbar vor dem einen Senden, als Zustand `snapshotted`. Scheitert der Snapshot, sendet der Kern nichts, und der Vorgang endet in `failed`. Eine neue Seite sichert er vor dem Senden mit dem, was er weiss, und ergänzt den Eintrag danach. Bleibt er unvollständig, führt `ecclium undo` zum Hinweis, die Kategorie von Hand zu prüfen.
- **Abschalten:** `ECCLIUM_SNAPSHOTS` mit `on`, voreingestellt, und `off`. Die Frist ist fest 30 Tage. Mit `off` versiegelt der Kern jeden Plan mit `reversible: no`, das Echo gilt für keinen, und jeder Start mit Schreiben warnt.
- **Ergebnis:** Das Ergebnis eines Schreib-Tools trägt mit einem Snapshot das Feld `undoId`, die Kennung für `ecclium undo`.

### Rücknahme

- **Befehl:** `ecclium undo <Kennung> [--overwrite]` mit der Konfiguration des Servers. Er läuft durch die Pipeline und den Write-Guard, im Modus `operator` und mit einem Nachweis des Betreibers ([ADR 0029](0029-write-guard.md)). Die Vorhaben der Rücknahme sind Vorhaben des Kerns ohne Typ in der Schnittstelle für Plugins, kein Plugin kann sie planen.
- **Handänderung:** Ist das Ziel seit dem Schreibvorgang unverändert, schreibt der Befehl zurück. Hat es jemand geändert, schreibt er nichts, zeigt den Unterschied als Zeilenvergleich und endet mit 65. Mit `--overwrite` schreibt er trotzdem, und der Stand davor bekommt selbst einen Snapshot.
- **Text:** Der gesicherte Text geht unverändert zurück, ohne ContentPolicy ([ADR 0030](0030-contentpolicy.md)), weil er der Stand vor Ecclium ist. Sonst liesse sich eine Seite, die vorher schon einen Link trug, nie zurücknehmen. Eine neue Seite löscht der Befehl nicht, er ersetzt ihren Text durch einen festen Satz, der durch die ContentPolicy geht: «Diese Seite hat Ecclium am <Datum> angelegt und am <Datum> zurückgenommen.» Termine und Buchungen nimmt er mit ihren Tools zurück, wie [ADR 0029](0029-write-guard.md) es sagt.
- **Richtlinie:** Der interaktive Teil der Richtlinie ([ADR 0032](0032-richtlinie-und-pruefcode.md)) gilt für eine Rücknahme nicht, und sie zählt nicht gegen seine Obergrenzen. Es gelten Kill-Switches, `ECCLIUM_READ_ONLY`, die Rechte als Rat, die Uhr, das Lesen vor und nach dem Schreiben, Snapshot und Audit. Zurückgenommen wird nur, was ein Snapshot belegt.
- **Audit:** neuer Typ `undo` mit dem Feld `undoes`, der Kennung des zurückgenommenen Schreibvorgangs, rückwärtsverträglich wie `writeState`.
- **Ausgabe:** Was der Befehl aus einer Seite zeigt, ist fremder Text. Steuerzeichen, Escape-Folgen, Bidi- und unsichtbare Zeichen ersetzt er vor der Ausgabe sichtbar, damit eine Seite das Terminal nicht steuern kann. In Log und Audit steht nie Text aus einem Snapshot.
- **Codes** nach sysexits: 0 zurückgenommen oder nichts zu tun, 64 falscher Aufruf, 65 von Hand geändert, 66 kein Snapshot, 69 ChurchTools nicht erreichbar oder Ausgang unklar, 70 intern, 77 abgewiesen, 78 Konfiguration.
- **Zeilenvergleich:** eigener Code nach Myers über Zeilen, ohne Abhängigkeit, weil `diff` keinen Herkunftsnachweis trägt. Über 2'000 Änderungen gilt der ganze Text als ersetzt.

## Konsequenzen

- Schreiben braucht einen zweiten Ordner. Ohne `ECCLIUM_KEYS_DIR` schreibt der Server nicht.
- Zwei Prozesse mit demselben Ordner der Schlüssel teilen die Tagesschlüssel, also kann jeder die Snapshots des anderen lesen und zurücknehmen.
- Der `KeyProvider` hat neue Methoden, und es gibt den Port `SnapshotStore`. Ein Ersatz aus einem Plugin besteht dieselben Prüfungen in `testkit`.
- **Restrisiken:**
  - Auf SSDs und Dateisystemen wie APFS überschreibt Nullen nicht sicher jede Kopie der Bytes. Lokale Snapshots von Time Machine und Snapshots einer virtuellen Maschine beim Hoster können den Ordner der Schlüssel enthalten. Ob `tmutil addexclusion` auch die lokalen Snapshots ausnimmt, ist nicht geprüft.
  - Wer beide Ordner kopiert, liest die Snapshots bis zum Ende ihrer Frist. Der Schutz wirkt gegen Sicherungen ohne Schlüssel, nicht gegen den Betreiber.
  - Ein Absturz zwischen `link` und dem Entfernen des temporären Namens lässt eine zweite Verknüpfung des Schlüssels zurück. Die Vernichtung findet und nullt sie.
  - Geht ein Tagesschlüssel verloren, etwa mit einer neuen Platte, lassen sich die Snapshots seines Tages nicht mehr zurücknehmen. Geschrieben ist dann trotzdem, die Versionen in ChurchTools bleiben.

## Umsetzung

Teil 1 seit dem 03.11.2026, die Tagesschlüssel. Am Server ändert er, dass Schreiben den Ordner der Schlüssel verlangt und dass der Start mit dem Ordner den Unterordner `snapshot` anlegt und Tagesschlüssel nach ihrer Frist vernichtet. Einen Tagesschlüssel legt noch nichts an.

- **Dateien:** `packages/core/src/files/` legt private Ordner an und prüft sie, schreibt eine Datei einmal mit `link`, liest sie nur als gewöhnliche Datei des Benutzers ohne Rechte für andere und mit begrenzter Grösse, löscht beim Lesen verworfene Bytes und vernichtet einen Eintrag wie oben beschrieben. Kein Fehler nennt einen Pfad. Der `QuotaStore` behält seinen eigenen Code, weil seine Dateien sich ändern und eine Sperrdatei brauchen.
- **Schlüssel:** `packages/core/src/keys/day-keys.ts` mit `createFileDayKeys` und `prepareDayKeyFolder`, `createFileKeyProvider` nimmt die Tagesschlüssel neben den Geheimnissen der Pseudonyme. Ohne eines von beiden verwerfen die zugehörigen Methoden. `destroyBefore` geht über einen Eintrag, der stehen bleibt, hinweg und verwirft erst danach.
- **Prüfungen:** `dayKeyChecks` und Tagesschlüssel im Arbeitsspeicher in `testkit`, mit Gegenproben für Schlüssel, die ein Neustart verliert, die nie vernichtet werden oder die für jeden Zweck und Tag öffnen.
- **Konfiguration:** `ECCLIUM_KEYS_DIR` gilt nur über stdio und wird geprüft wie der Zustandsordner, mit höchstens 896 Bytes, damit der Pfad eines temporären Schlüssels unter der Grenze von 1'024 Bytes für Pfade unter macOS bleibt. Die Ordner `snapshot` und `queue` darin prüft der Lader, wo es sie gibt, legt aber nichts an. Probleme: `keys_dir_*` für den Ordner, `snapshot_keys_dir_*` und `queue_keys_dir_*` für die Ordner darin, `keys_dir_required` mit `ECCLIUM_READ_ONLY=false` ohne Ordner, `keys_dir_in_state_dir` und `state_dir_in_keys_dir`. Dieser Vergleich nimmt die beiden Pfade als Text, ein Dateisystem ohne Unterschied von Gross und Klein und einen Link in einem Ordner darüber sieht er nicht. Weil die Variable nur über stdio gilt, lässt sich über HTTP in dieser Version nicht schreiben. `ecclium config check` zeigt den «Schlüsselordner», seinen Pfad nur mit `--show-values`.
- **Start:** Die erste Stufe des Starts über stdio legt den Ordner `snapshot` an und prüft ihn, ein unbrauchbarer beendet den Start mit 78. Beim Start und mit dem Zeitgeber des Tages, der mindestens stündlich schaut, vernichtet der Server die Tagesschlüssel der Snapshots vor dem Tag, der 30 Tage vor dem laufenden liegt, auch wenn er nur liest, damit Schlüssel eines früheren Laufs mit Schreiben trotzdem rechtzeitig gehen. Die Logzeile `day_keys_destroyed` nennt die Zahl, `day_keys_not_destroyed` warnt ohne Pfad und ohne Meldung, auch wenn die Uhr keinen Tag ergibt, und der nächste Lauf des Zeitgebers versucht es wieder.
- **Architektur:** Die Regeln `keys-internals` und `key-provider-only-from-composition-root` lassen die Tagesschlüssel wie den Provider nur von der Wurzel der Komposition bauen, mit einem Beispiel, das rot wird. Ein Test mit zwei Prozessen zeigt, dass beide am selben neuen Tag denselben Schlüssel bekommen, und scheitert mit einem Schreiber, der einen vorhandenen Schlüssel ersetzt.
- **Später:** die Rücknahme mit `ecclium undo` und der Zeilenvergleich kommen in einem eigenen Teil.

Teil 2 seit dem 03.11.2026, die Snapshots. Schreib-Tools des Kerns gibt es noch nicht, darum entsteht ein Snapshot bisher nur mit einem Schreib-Tool eines Plugins wie dem Beispiel aus `testkit`.

- **Port:** `SnapshotStore` in der Schnittstelle für Plugins mit `put`, `get` und `purgeBefore`, nur für versiegelte Einträge, je Teil `before` oder `after`. Ein Teil wird je Mandant, Ereignis und Tag einmal gehalten: Die Kennung eines Ereignisses ist für jeden Aufruf neu, und ein Blick in ältere Tage liesse einen fremden Eintrag dort jedes Schreiben aufhalten. Die Prüfungen jedes Stores stehen in `testkit`.
- **Versiegeln:** `packages/core/src/snapshots/seal.ts`. Ein Teil ist JSON mit `v: 1`, verschlüsselt mit einem eigenen Schlüssel und AES-256-GCM, zusätzliche Daten Format, Mandant, Instanz, Ereignis, Teil und Tag. Der Eintrag ist der umhüllte Schlüssel, ein Punkt und der Inhalt in base64url, höchstens 16 MiB. Beim Öffnen prüft der Kern jedes Feld wieder.
- **Ablage:** `createFileSnapshotStore` unter `<ECCLIUM_STATE_DIR>/snapshots/<Tag>/<Mandant>.<Ereignis>.<Teil>.snapshot`, jede Datei einmal mit `link`, und `createSnapshotKeeper` verbindet Schlüssel und Ablage: Sichern, Laden für `ecclium undo` und Löschen nach der Frist samt den Tagesschlüsseln.
- **Write-Guard:** Mit Snapshots sichert das Festschreiben den Teil `before` unmittelbar vor dem Senden, unter der `eventId` der Zeile im Audit. Scheitert das, sendet der Kern nichts, `failed` mit festem Satz und der Logzeile `snapshot_failed`. Den Teil `after` einer neuen Seite sichert er nach dem Lesen danach, scheitert das, bleibt die Seite geschrieben und `snapshot_incomplete` steht im Log. Das Ergebnis trägt `undoId`. Ohne Snapshots versiegelt der Kern jeden Plan mit `reversible: no`, und das Echo gilt für keinen. Der Hash des Plans bleibt derselbe.
- **Konfiguration und Start:** `ECCLIUM_SNAPSHOTS` mit `on`, der Voreinstellung, und `off`. Die Pipeline bekommt die Snapshots nur, wenn der Server schreibt, sie eingeschaltet sind und beide Ordner gesetzt sind, `keepsSnapshots` in `packages/cli/src/compose/snapshots.ts` hält diese Regel für beide Stufen des Starts. Dann legt die erste Stufe den Ordner `snapshots` an, und lässt er sich nicht nutzen, bricht der Start mit 78 ab. Mit beiden Ordnern löschen der Start und der Zeitgeber des Tages die Einträge nach der Frist samt ihren Tagesschlüsseln, auch in einem Lauf, der nur liest oder keine Snapshots hält, mit den Logzeilen `snapshots_deleted` und `snapshots_not_deleted`. Mit `off` und Schreiben warnt jeder Start mit `snapshots_off`.
