import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import type { ServerOptions } from 'node:https'
import type { SecureContextOptions } from 'node:tls'

type PemInput = string | Buffer

export interface SwTlsInput {
  key: PemInput
  cert: PemInput
  ca?: PemInput
  serverName?: string
}

export interface SwTestTlsConfig {
  serverOptions: Pick<ServerOptions, 'key' | 'cert'>
  clientOptions: Pick<SecureContextOptions, 'ca'> & { servername: string }
  certificate: string | Buffer
  spkiSha256: string
}

function publicKeyFingerprint(key: ReturnType<typeof createPublicKey>): string {
  const spki = key.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('base64')
}

function isEmptyPem(value: PemInput): boolean {
  return typeof value === 'string' ? value.length === 0 : value.byteLength === 0
}

export function createSwTestTlsConfig(input: SwTlsInput): SwTestTlsConfig {
  if (isEmptyPem(input.key)) {
    throw new Error('TLS private key is required')
  }
  if (isEmptyPem(input.cert)) {
    throw new Error('TLS certificate is required')
  }
  const certificate = new X509Certificate(input.cert)
  const privateKey = createPrivateKey(input.key)
  const certificateFingerprint = publicKeyFingerprint(certificate.publicKey)
  const privateFingerprint = publicKeyFingerprint(createPublicKey(privateKey))
  if (certificateFingerprint !== privateFingerprint) throw new Error('TLS certificate does not match its private key')
  const servername = input.serverName ?? 'localhost'
  const matchesName = servername.includes(':') || /^\d+(?:\.\d+){3}$/.test(servername)
    ? certificate.checkIP(servername)
    : certificate.checkHost(servername)
  if (!matchesName) throw new Error(`TLS certificate does not cover ${servername}`)
  return {
    serverOptions: { key: input.key, cert: input.cert },
    clientOptions: { ca: input.ca ?? input.cert, servername },
    certificate: input.cert,
    spkiSha256: certificateFingerprint,
  }
}

export function chromiumSpkiTrustArgs(tls: SwTestTlsConfig): readonly string[] {
  return [`--ignore-certificate-errors-spki-list=${tls.spkiSha256}`]
}
