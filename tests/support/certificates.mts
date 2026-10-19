// Keys and certificates for tests over TLS (ADR 0056). openssl makes them
// at run time in a temporary folder of the test, so that no key and no
// certificate lies in the repository.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** Where a key and its certificate lie. */
export interface Certificate {
  /** The private key, in PEM. */
  readonly key: string;
  /** The self-signed certificate, in PEM. */
  readonly cert: string;
}

/**
 * Finds an openssl that can add a subjectAltName. macOS brings LibreSSL
 * under /usr/bin, Homebrew a current OpenSSL.
 *
 * @returns The command of the first such openssl.
 * @throws {Error} When none is found.
 */
export function findOpenssl(): string {
  for (const candidate of [
    'openssl',
    '/opt/homebrew/bin/openssl',
    '/usr/local/bin/openssl',
    '/usr/bin/openssl',
  ]) {
    const help = spawnSync(candidate, ['req', '-help'], { encoding: 'utf8' });
    if (`${help.stdout}${help.stderr}`.includes('-addext')) return candidate;
  }
  throw new Error(
    'No openssl with -addext found; install OpenSSL 1.1.1 or newer.',
  );
}

/**
 * Makes an EC key and a self-signed certificate for one host, valid for a
 * day, as `<name>.key` and `<name>.crt` in the folder.
 *
 * @param openssl - The command that {@link findOpenssl} found.
 * @param folder - The temporary folder of the test.
 * @param name - The name of both files, without extension.
 * @param host - The DNS name in the subject and in the subjectAltName.
 * @returns Where the key and the certificate lie.
 * @throws {Error} When openssl fails.
 */
export function makeCertificate(
  openssl: string,
  folder: string,
  name: string,
  host: string,
): Certificate {
  const key = join(folder, `${name}.key`);
  const cert = join(folder, `${name}.crt`);
  const made = spawnSync(
    openssl,
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=DNS:${host}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { encoding: 'utf8' },
  );
  if (made.status !== 0) throw new Error(`openssl failed: ${made.stderr}`);
  return { key, cert };
}
