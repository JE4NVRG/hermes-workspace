/**
 * Feature flags do Project Center v2 (PR 1).
 *
 * Regra canônica do plano: as duas flags nascem ausentes/`false` e **qualquer
 * valor diferente da string exata `true` deve ser lido como desligado**
 * (inclusive `TRUE`, `1`, `yes`, `on`, string vazia e valor com espaços).
 * Leitura fechada: nunca abre conexão, nunca executa DDL, nunca chama Docker,
 * nunca escreve secret, nunca publica registry e nunca toca backup/R2.
 */

export const PROJECT_CENTER_V2_FLAG = 'PROJECT_CENTER_V2_ENABLED'
export const PROJECT_CENTER_V2_WORKER_FLAG = 'PROJECT_CENTER_V2_WORKER_ENABLED'
/** Único valor que liga uma flag. Comparação exata, sem trim. */
export const ENABLED_FLAG_VALUE = 'true'

export type EnvSource = Readonly<Record<string, string | undefined>>

export type FlagReason = 'enabled' | 'absent' | 'disabled_by_value'

export interface FlagInspection {
  readonly name: string
  readonly raw: string | undefined
  readonly enabled: boolean
  readonly reason: FlagReason
}

export interface ProjectCenterV2Flags {
  /** `PROJECT_CENTER_V2_ENABLED`. */
  readonly apiEnabled: boolean
  /** `PROJECT_CENTER_V2_WORKER_ENABLED`. */
  readonly workerEnabled: boolean
  readonly api: FlagInspection
  readonly worker: FlagInspection
}

export function inspectFlag(
  name: string,
  raw: string | undefined,
): FlagInspection {
  if (raw === undefined) {
    return { name, raw, enabled: false, reason: 'absent' }
  }
  if (raw === ENABLED_FLAG_VALUE) {
    return { name, raw, enabled: true, reason: 'enabled' }
  }
  return { name, raw, enabled: false, reason: 'disabled_by_value' }
}

/** Lê as duas flags. Default (ausência) é desligado. */
export function resolveProjectCenterV2Flags(
  env: EnvSource = process.env,
): ProjectCenterV2Flags {
  const api = inspectFlag(PROJECT_CENTER_V2_FLAG, env[PROJECT_CENTER_V2_FLAG])
  const worker = inspectFlag(
    PROJECT_CENTER_V2_WORKER_FLAG,
    env[PROJECT_CENTER_V2_WORKER_FLAG],
  )
  return {
    apiEnabled: api.enabled,
    workerEnabled: worker.enabled,
    api,
    worker,
  }
}

/**
 * O worker só é considerado ativo quando a API v2 e o worker estão ligados:
 * worker ligado com API desligada não tem outbox e não pode executar nada.
 */
export function isWorkerActive(flags: ProjectCenterV2Flags): boolean {
  return flags.apiEnabled && flags.workerEnabled
}

/** Retrato sem segredo para health/log: apenas estado das flags. */
export function describeFlags(
  flags: ProjectCenterV2Flags,
): Record<string, string> {
  return {
    [PROJECT_CENTER_V2_FLAG]: flags.apiEnabled ? 'enabled' : 'disabled',
    [PROJECT_CENTER_V2_WORKER_FLAG]: flags.workerEnabled
      ? 'enabled'
      : 'disabled',
  }
}

/**
 * Erro tipado de gate fechado. Não é serializado neste PR: a camada HTTP do
 * PR 4 mapeia para o catálogo de erros do contrato sem side effect.
 */
export class FeatureDisabledError extends Error {
  readonly code = 'feature_disabled'
  readonly flag: string

  constructor(flag: string) {
    super(`funcionalidade desligada: ${flag}`)
    this.name = 'FeatureDisabledError'
    this.flag = flag
  }
}

/** Falha fechada quando a API v2 não está habilitada. */
export function requireApiEnabled(flags: ProjectCenterV2Flags): void {
  if (!flags.apiEnabled) throw new FeatureDisabledError(PROJECT_CENTER_V2_FLAG)
}

/** Falha fechada quando o worker não pode executar. */
export function requireWorkerActive(flags: ProjectCenterV2Flags): void {
  if (!flags.apiEnabled) throw new FeatureDisabledError(PROJECT_CENTER_V2_FLAG)
  if (!flags.workerEnabled) {
    throw new FeatureDisabledError(PROJECT_CENTER_V2_WORKER_FLAG)
  }
}
