/**
 * Testes das feature flags e da ausência de efeitos privilegiados.
 *
 * As flags nascem desligadas e qualquer valor diferente da string exata `true`
 * é tratado como desligado. O último bloco é um guarda de arquitetura: ele
 * varre os módulos do PR 1 e falha se algum deles importar `child_process`,
 * Docker, cliente de banco, filesystem, rede ou AWS, ou instanciar store de
 * runtime.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as auditStoreModule from './audit-store'
import * as operationStoreModule from './operation-store'
import {
  ENABLED_FLAG_VALUE,
  FeatureDisabledError,
  PROJECT_CENTER_V2_FLAG,
  PROJECT_CENTER_V2_WORKER_FLAG,
  describeFlags,
  inspectFlag,
  isWorkerActive,
  requireApiEnabled,
  requireWorkerActive,
  resolveProjectCenterV2Flags,
} from './feature-flags'

const PR_MODULES = [
  'feature-flags',
  'domain',
  'state-machine',
  'policy',
  'redaction',
  'audit-store',
  'operation-store',
] as const

const ALLOWED_SPECIFIERS = new Set([
  'zod',
  'node:crypto',
  './domain',
  './state-machine',
  './policy',
  './redaction',
  './audit-store',
  './operation-store',
  './feature-flags',
])

const FORBIDDEN_SPECIFIERS = [
  'child_process',
  'docker',
  'dockerode',
  'podman',
  'postgres',
  'pg',
  'pg-pool',
  'mysql',
  'mongodb',
  'redis',
  'ioredis',
  'knex',
  'sequelize',
  'prisma',
  'node:fs',
  'node:net',
  'node:http',
  'node:https',
  'node:dns',
  'node:tls',
  'node:vm',
  'node:worker_threads',
  'node:cluster',
  'undici',
  'axios',
  'node-fetch',
  '@aws-sdk',
  '@supabase/supabase-js',
]

function moduleSource(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`./${name}.ts`, import.meta.url)),
    'utf8',
  )
}

function importSpecifiers(source: string): Array<string> {
  const found: Array<string> = []
  const pattern = /(?:from\s*|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g
  for (const match of source.matchAll(pattern)) found.push(match[1])
  return found
}

function env(entries: Record<string, string>): Record<string, string> {
  return { ...entries }
}

describe('default desligado', () => {
  it('trata flag ausente como desligada', () => {
    const flags = resolveProjectCenterV2Flags(env({}))
    expect(flags.apiEnabled).toBe(false)
    expect(flags.workerEnabled).toBe(false)
    expect(flags.api.reason).toBe('absent')
    expect(flags.worker.reason).toBe('absent')
    expect(flags.api.raw).toBeUndefined()
    expect(describeFlags(flags)).toEqual({
      [PROJECT_CENTER_V2_FLAG]: 'disabled',
      [PROJECT_CENTER_V2_WORKER_FLAG]: 'disabled',
    })
  })

  it('trata qualquer valor diferente de true como desligado', () => {
    for (const value of [
      'false',
      'FALSE',
      'False',
      '0',
      '1',
      'yes',
      'on',
      'enabled',
      '',
      ' ',
      'true ',
      ' true',
      'TRUE',
      'True',
      'truex',
      'verdadeiro',
      'null',
      'undefined',
    ]) {
      const flags = resolveProjectCenterV2Flags(
        env({ [PROJECT_CENTER_V2_FLAG]: value }),
      )
      expect(flags.apiEnabled, `valor ${JSON.stringify(value)}`).toBe(false)
      expect(flags.api.reason).toBe('disabled_by_value')
      expect(flags.api.raw).toBe(value)
    }
  })

  it('liga apenas com a string exata true', () => {
    expect(ENABLED_FLAG_VALUE).toBe('true')
    const flags = resolveProjectCenterV2Flags(
      env({
        [PROJECT_CENTER_V2_FLAG]: ENABLED_FLAG_VALUE,
        [PROJECT_CENTER_V2_WORKER_FLAG]: ENABLED_FLAG_VALUE,
      }),
    )
    expect(flags.apiEnabled).toBe(true)
    expect(flags.workerEnabled).toBe(true)
    expect(flags.api.reason).toBe('enabled')
    expect(describeFlags(flags)).toEqual({
      [PROJECT_CENTER_V2_FLAG]: 'enabled',
      [PROJECT_CENTER_V2_WORKER_FLAG]: 'enabled',
    })
  })

  it('mantem as duas flags independentes e exige ambas para o worker agir', () => {
    const onlyApi = resolveProjectCenterV2Flags(
      env({ [PROJECT_CENTER_V2_FLAG]: 'true' }),
    )
    expect(onlyApi.apiEnabled).toBe(true)
    expect(onlyApi.workerEnabled).toBe(false)
    expect(isWorkerActive(onlyApi)).toBe(false)

    const onlyWorker = resolveProjectCenterV2Flags(
      env({ [PROJECT_CENTER_V2_WORKER_FLAG]: 'true' }),
    )
    expect(onlyWorker.apiEnabled).toBe(false)
    expect(onlyWorker.workerEnabled).toBe(true)
    expect(isWorkerActive(onlyWorker)).toBe(false)

    const both = resolveProjectCenterV2Flags(
      env({
        [PROJECT_CENTER_V2_FLAG]: 'true',
        [PROJECT_CENTER_V2_WORKER_FLAG]: 'true',
      }),
    )
    expect(isWorkerActive(both)).toBe(true)
  })

  it('expoe inspecao por flag', () => {
    expect(inspectFlag('X', undefined)).toEqual({
      name: 'X',
      raw: undefined,
      enabled: false,
      reason: 'absent',
    })
    expect(inspectFlag('X', 'true').reason).toBe('enabled')
    expect(inspectFlag('X', 'no').reason).toBe('disabled_by_value')
  })
})

describe('falha fechada dos gates', () => {
  it('bloqueia a API com flag desligada e usa erro tipado', () => {
    const flags = resolveProjectCenterV2Flags(env({}))
    try {
      requireApiEnabled(flags)
      throw new Error('deveria ter falhado')
    } catch (error) {
      expect(error).toBeInstanceOf(FeatureDisabledError)
      expect((error as FeatureDisabledError).code).toBe('feature_disabled')
      expect((error as FeatureDisabledError).flag).toBe(PROJECT_CENTER_V2_FLAG)
    }
    expect(() => requireWorkerActive(flags)).toThrow(FeatureDisabledError)
  })

  it('bloqueia o worker com API ligada e worker desligado', () => {
    const flags = resolveProjectCenterV2Flags(
      env({ [PROJECT_CENTER_V2_FLAG]: 'true' }),
    )
    expect(() => requireApiEnabled(flags)).not.toThrow()
    try {
      requireWorkerActive(flags)
      throw new Error('deveria ter falhado')
    } catch (error) {
      expect((error as FeatureDisabledError).flag).toBe(
        PROJECT_CENTER_V2_WORKER_FLAG,
      )
    }
  })

  it('libera os gates apenas com as duas flags ligadas', () => {
    const flags = resolveProjectCenterV2Flags(
      env({
        [PROJECT_CENTER_V2_FLAG]: 'true',
        [PROJECT_CENTER_V2_WORKER_FLAG]: 'true',
      }),
    )
    expect(() => requireApiEnabled(flags)).not.toThrow()
    expect(() => requireWorkerActive(flags)).not.toThrow()
  })
})

describe('ausencia de efeitos privilegiados', () => {
  it('nao importa child_process, Docker, banco, rede ou AWS', () => {
    for (const name of PR_MODULES) {
      const specifiers = importSpecifiers(moduleSource(name))
      for (const specifier of specifiers) {
        expect(
          FORBIDDEN_SPECIFIERS.some((forbidden) =>
            specifier.toLowerCase().includes(forbidden),
          ),
          `${name}.ts importa ${specifier}`,
        ).toBe(false)
        expect(
          ALLOWED_SPECIFIERS,
          `${name}.ts importa ${specifier} (fora da allowlist)`,
        ).toContain(specifier)
      }
    }
  })

  it('nao instancia store de runtime no modulo', () => {
    for (const name of ['audit-store', 'operation-store'] as const) {
      const source = moduleSource(name)
      expect(source).not.toMatch(
        /createInMemory(?:Operation|Audit)Store\s*\(\s*\)/,
      )
    }
    const exported = [
      ...Object.values(auditStoreModule),
      ...Object.values(operationStoreModule),
    ].filter(
      (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        ('append' in value || 'transition' in value),
    )
    expect(exported).toEqual([])
    expect(typeof auditStoreModule.createInMemoryAuditStore).toBe('function')
    expect(typeof operationStoreModule.createInMemoryOperationStore).toBe(
      'function',
    )
  })

  it('nao executa DDL, shell ou Docker em nenhum modulo do PR', () => {
    for (const name of PR_MODULES) {
      const source = moduleSource(name)
      for (const pattern of [
        /\bexecSync\b/,
        /\bspawnSync\b/,
        /\bFUNCTION\b/,
        /\bCREATE\s+DATABASE\b/i,
        /\bDROP\s+(?:DATABASE|ROLE|TABLE)\b/i,
        /\bdocker\s+(?:compose|run)\b/i,
      ]) {
        expect(pattern.test(source), `${name}.ts casa ${String(pattern)}`).toBe(
          false,
        )
      }
    }
  })
})
