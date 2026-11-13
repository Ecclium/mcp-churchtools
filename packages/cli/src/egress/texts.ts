/**
 * The texts of `ecclium init egress` (ADR 0035), in German, each with
 * what happened, why and what to do. No text names a host, a port or a
 * path of the configuration; a target is named by its role.
 *
 * @packageDocumentation
 */

/** The texts of the command, by case. */
export const egressInitTexts = Object.freeze({
  config_invalid:
    'Die Konfiguration des Runners ist ungültig, deshalb hat ‹ecclium init egress› keine Liste geschrieben. Die Liste nennt die Ziele genau dieser Konfiguration. Beheben Sie die Probleme oben und prüfen Sie mit ‹ecclium config check --runner›.',
  output_cut:
    'Die Liste liess sich nicht ganz auf stdout schreiben. Squid darf eine halbe Liste nicht laden. Leiten Sie die Ausgabe in eine neue Datei um, versuchen Sie es erneut und ersetzen Sie die alte Liste erst danach.',
  port: (roles: readonly string[]): string =>
    `Die Liste wurde nicht geschrieben: ${roles.join(', ')} ${roles.length === 1 ? 'hat' : 'haben'} einen anderen Port als 443 und ${roles.length === 1 ? 'steht' : 'stehen'} nicht in ‹ECCLIUM_EGRESS_ALLOW_LAN›. Die Vorlage für Squid lässt ausserhalb des lokalen Netzes nur Port 443 zu, das Ziel käme also nie durch. Nehmen Sie Name und Port in ‹ECCLIUM_EGRESS_ALLOW_LAN› auf, wenn das Ziel im lokalen Netz liegt, sonst geben Sie es mit Port 443 an.`,
});
