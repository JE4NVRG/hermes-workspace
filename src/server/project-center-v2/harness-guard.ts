/**
 * Guard do harness efémero do Project Center v2 (canário P3-03).
 *
 * Fonte da verdade: spec §14 (verificação) e passo 13 do plano de implementação
 * ("executar integration harness apenas com variáveis explícitas de teste e
 * guard que recuse host/path de produção").
 *
 * O harness só roda com **opt-in explícito** e recusa qualquer coisa que possa
 * apontar para produção: ambiente `production`, host target fora da allowlist,
 * endpoint fora de loopback/janela efémera, porta denylistada, prefixo/path
 * absoluto ou com segmento de produção, e DSN em variável de ambiente que não
 * seja loopback. Falha é sempre fechada: sem exceção silenciosa.
 *
 * Este módulo não toca rede, disco nem processo: é só decisão.
 */
import { ENVIRONMENTS } from './domain'
import {
  EXECUTION_LOOPBACK_HOSTS,
  EXECUTION_PORT_DENYLIST,
} from './executors/action-executor'
import type { Environment } from './domain'

/** Variável de opt-in explícito do harness (valor exato `1`). */
export const HARNESS_OPT_IN_ENV = 'PROJECT_CENTER_V2_TEST_HARNESS'
/** Variável de ambiente com a qual o harness se apresenta. */
export const HARNESS_ENVIRONMENT_ENV = 'PROJECT_CENTER_V2_ENVIRONMENT'
/** Host targets aceitos em harness efémero (nunca VPS de produção). */
export const HARNESS_ALLOWED_HOST_TARGETS: ReadonlyArray<string> =
  Object.freeze(['vps-primary-local'])
/** Janela de portas efémeras do harness (acima das portas de produção). */
export const HARNESS_EPHEMERAL_PORT_MIN = 10240
export const HARNESS_EPHEMERAL_PORT_MAX = 65000
/** Segmentos proibidos em prefixo/path do harness (case-insensitive). */
export const HARNESS_FORBIDDEN_PATH_SEGMENTS: ReadonlyArray<string> =
  Object.freeze([
    'production',
    'prod',
    'prd',
    'live',
    'legacy',
    '/var/lib/postgresql',
    '/etc',
    '/root',
    '/srv',
    '/data',
    '..',
  ])
/** Chaves de ambiente que nunca podem carregar credencial de produção. */
export const HARNESS_CREDENTIAL_ENV_PATTERN =
  /(DSN|DATABASE_URL|POSTGRES|SUPABASE|CONNECTION_STRING)/i
/** Hosts de loopback aceitos (espelha o allowlist do executor). */
export const HARNESS_LOOPBACK_HOSTS: ReadonlyArray<string> =
  EXECUTION_LOOPBACK_HOSTS

export type HarnessGuardReason =
  | 'opt_in_ausente'
  | 'ambiente_de_producao'
  | 'host_target_nao_permitido'
  | 'endpoint_fora_de_loopback'
  | 'porta_fora_da_janela_efemera'
  | 'porta_denylistada'
  | 'caminho_nao_efemero'
  | 'dsn_fora_de_loopback'
  | 'ambiente_invalido'

/** Recusa fechada do guard: código público `POLICY_DENIED` + motivo. */
export class HarnessGuardError extends Error {
  readonly code = 'POLICY_DENIED'
  readonly reason: HarnessGuardReason

  constructor(reason: HarnessGuardReason) {
    super('harness efemero recusado')
    this.name = 'HarnessGuardError'
    this.reason = reason
  }
}

export interface EphemeralHarnessRequest {
  readonly environment: Environment
  readonly host_target: string
  readonly endpoint: {
    readonly host: string
    readonly port: number
  }
  /** Diretório de trabalho do harness (relativo, se informado). */
  readonly work_dir?: string
  /** Prefixo do destino de backup (relativo, sem path). */
  readonly backup_prefix?: string
}

function assertRelativeSafePath(
  value: string,
  reason: HarnessGuardReason,
): void {
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) throw new HarnessGuardError(reason)
  if (normalized.startsWith('/') || normalized.startsWith('~')) {
    throw new HarnessGuardError(reason)
  }
  if (/^[a-z]:[\\/]/.test(normalized)) throw new HarnessGuardError(reason)
  if (
    HARNESS_FORBIDDEN_PATH_SEGMENTS.some((segment) =>
      normalized.includes(segment),
    )
  ) {
    throw new HarnessGuardError(reason)
  }
}

/**
 * Valida o ambiente do harness. Lança `HarnessGuardError` (fechado) em qualquer
 * sinal de produção; retorna `void` somente quando tudo é efémero.
 */
export function assertEphemeralHarness(
  request: EphemeralHarnessRequest,
  env: Readonly<Record<string, string | undefined>> = {},
): void {
  if (env[HARNESS_OPT_IN_ENV] !== '1') {
    throw new HarnessGuardError('opt_in_ausente')
  }
  if (
    typeof request.environment !== 'string' ||
    !(ENVIRONMENTS as ReadonlyArray<string>).includes(request.environment)
  ) {
    throw new HarnessGuardError('ambiente_invalido')
  }
  if (request.environment === 'production') {
    throw new HarnessGuardError('ambiente_de_producao')
  }
  if (env[HARNESS_ENVIRONMENT_ENV] === 'production') {
    throw new HarnessGuardError('ambiente_de_producao')
  }
  if (!HARNESS_ALLOWED_HOST_TARGETS.includes(request.host_target)) {
    throw new HarnessGuardError('host_target_nao_permitido')
  }
  if (!HARNESS_LOOPBACK_HOSTS.includes(request.endpoint.host)) {
    throw new HarnessGuardError('endpoint_fora_de_loopback')
  }
  const port = request.endpoint.port
  if (
    !Number.isInteger(port) ||
    port < HARNESS_EPHEMERAL_PORT_MIN ||
    port > HARNESS_EPHEMERAL_PORT_MAX
  ) {
    throw new HarnessGuardError('porta_fora_da_janela_efemera')
  }
  if ((EXECUTION_PORT_DENYLIST as ReadonlyArray<number>).includes(port)) {
    throw new HarnessGuardError('porta_denylistada')
  }
  if (request.work_dir !== undefined) {
    assertRelativeSafePath(request.work_dir, 'caminho_nao_efemero')
  }
  if (request.backup_prefix !== undefined) {
    assertRelativeSafePath(request.backup_prefix, 'caminho_nao_efemero')
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || !HARNESS_CREDENTIAL_ENV_PATTERN.test(key))
      continue
    const loopback = HARNESS_LOOPBACK_HOSTS.some((host) => value.includes(host))
    if (!loopback) throw new HarnessGuardError('dsn_fora_de_loopback')
  }
}
