/**
 * Testes do naming determinístico (PR 2).
 *
 * Cobrem a tabela do §4 da spec: forma canônica de database/role/prefixos,
 * normalização, limites de identifier, colisão entre recursos e rejeição de
 * qualquer identifier bruto vindo do cliente (nada de SQL, aspas, path ou
 * unicode). Nome inválido e colisão falham fechado — nunca há fallback.
 */
import { describe, expect, it } from 'vitest'
import {
  APP_ROLE_SUFFIX,
  NAMING_VERSION,
  POSTGRES_IDENTIFIER_MAX_BYTES,
  appRoleNameFor,
  assertDistinctNames,
  assertPostgresIdentifier,
  buildNamingSnapshot,
  composeProjectNameFor,
  dataStoreNameFor,
  databaseNameFor,
  isPostgresIdentifier,
  localBackupPrefixFor,
  networkNameFor,
  normalizeSlug,
  ownershipMarkerFor,
  ownershipMatches,
  parseOwnershipMarker,
  projectIdFor,
  r2PrefixFor,
  resolveResourceName,
} from './naming'
import type { DesiredResource, ExistingResource } from './naming'

const INPUT = { client_id: 'acme', project_slug: 'site-institucional' }

function desired(overrides: Partial<DesiredResource> = {}): DesiredResource {
  const snapshot = buildNamingSnapshot({
    ...INPUT,
    environment: 'development',
    driver: 'postgresql_isolated',
  })
  return {
    name: snapshot.database,
    project_id: snapshot.project_id,
    driver: 'postgresql_isolated',
    environment: 'development',
    ownership_marker: snapshot.ownership_marker,
    ...overrides,
  }
}

describe('forma canônica', () => {
  it('deriva database e app role determinísticos', () => {
    const database = 'je4ndev_acme_site_institucional'
    expect(databaseNameFor(INPUT)).toBe(database)
    expect(databaseNameFor(INPUT)).toBe(database)
    expect(appRoleNameFor(database)).toBe(`${database}${APP_ROLE_SUFFIX}`)
  })

  it('converte hífen em underscore no database', () => {
    const database = databaseNameFor({
      client_id: 'je4n-dev',
      project_slug: 'meu-app',
    })
    expect(database).toBe('je4ndev_je4n_dev_meu_app')
    expect(database.includes('-')).toBe(false)
  })

  it('normaliza caixa sem aceitar caracteres fora do padrão', () => {
    expect(normalizeSlug('Acme', 'client_id')).toBe('acme')
    expect(normalizeSlug('ACME-DEV', 'client_id')).toBe('acme-dev')
    expect(databaseNameFor({ client_id: 'ACME', project_slug: 'Site' })).toBe(
      'je4ndev_acme_site',
    )
  })

  it('mantém project_id, prefixos e nomes de Compose na forma do §4', () => {
    const snapshot = buildNamingSnapshot({
      ...INPUT,
      environment: 'staging',
      driver: 'postgresql_isolated',
    })
    expect(snapshot.naming_version).toBe(NAMING_VERSION)
    expect(snapshot.project_id).toBe('acme-site-institucional')
    expect(snapshot.compose_project).toBe('je4ndev-sb-acme-site-institucional')
    expect(snapshot.network).toBe('je4ndev-sb-acme-site-institucional-net')
    expect(snapshot.data_store).toBe(
      'je4ndev-sb-acme-site-institucional-postgres-data',
    )
    expect(snapshot.local_backup_prefix).toBe(
      'acme-site-institucional/staging/postgres/',
    )
    expect(snapshot.r2_prefix).toBe(
      'projects/acme-site-institucional/staging/postgres/',
    )
    expect(snapshot.ownership_marker).toBe(
      'je4ndev:pcv2:postgresql_isolated:staging:acme-site-institucional',
    )
  })

  it('gera prefixos relativos, nunca path absoluto', () => {
    const local = localBackupPrefixFor({
      project_id: projectIdFor(INPUT.client_id, INPUT.project_slug),
      environment: 'production',
    })
    const r2 = r2PrefixFor({
      project_id: projectIdFor(INPUT.client_id, INPUT.project_slug),
      environment: 'production',
    })
    for (const prefix of [local, r2]) {
      expect(prefix.startsWith('/')).toBe(false)
      expect(prefix.includes('..')).toBe(false)
      expect(prefix.includes('\\')).toBe(false)
      expect(prefix.endsWith('/')).toBe(true)
    }
  })

  it('respeita o limite de 63 bytes mesmo nos extremos do slug', () => {
    const long = 'a'.repeat(23) + 'b'
    const database = databaseNameFor({ client_id: long, project_slug: long })
    const appRole = appRoleNameFor(database)
    expect(database.length).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES)
    expect(appRole.length).toBeLessThanOrEqual(POSTGRES_IDENTIFIER_MAX_BYTES)
    expect(assertPostgresIdentifier(appRole)).toBe(appRole)
  })
})

describe('rejeição de identifier bruto', () => {
  const hostile = [
    'acme"; DROP DATABASE x; --',
    'acme;DROP DATABASE x',
    'acme site',
    'acme.site',
    'acme/site',
    'acme\\site',
    'ACME$',
    'a',
    'a'.repeat(25),
    '-acme',
    '1acme',
    'acme_',
    'ação',
    'acme\u0000',
    '',
    ' ',
  ]

  it('recusa qualquer valor fora de [A-Za-z][A-Za-z0-9-]{1,23}', () => {
    for (const value of hostile) {
      expect(() => normalizeSlug(value, 'client_id'), value).toThrowError(
        /identificador invalido/,
      )
    }
  })

  it('recusa tipos não-string', () => {
    for (const value of [1, null, undefined, {}, [], true]) {
      expect(() => normalizeSlug(value, 'client_id')).toThrowError(
        /identificador invalido/,
      )
    }
  })

  it('recusa identifier fora da forma do PostgreSQL', () => {
    for (const value of [
      'je4ndev_Acme_x',
      'je4ndev-acme',
      'a'.repeat(64),
      '',
      'drop table',
      'je4ndev.a',
    ]) {
      expect(isPostgresIdentifier(value), value).toBe(false)
      expect(() => assertPostgresIdentifier(value)).toThrowError(
        /identificador invalido/,
      )
    }
  })

  it('recusa prefixos de backup com path absoluto ou traversal', () => {
    expect(() =>
      localBackupPrefixFor({ project_id: '/etc', environment: 'development' }),
    ).toThrowError(/identificador invalido/)
    expect(() =>
      r2PrefixFor({ project_id: '../etc', environment: 'development' }),
    ).toThrowError(/identificador invalido/)
  })
})

describe('ownership marker', () => {
  it('faz round-trip determinístico', () => {
    const marker = ownershipMarkerFor({
      project_id: 'acme-site',
      driver: 'postgresql_isolated',
      environment: 'development',
    })
    expect(marker).toBe(
      'je4ndev:pcv2:postgresql_isolated:development:acme-site',
    )
    expect(parseOwnershipMarker(marker)).toEqual({
      driver: 'postgresql_isolated',
      environment: 'development',
      project_id: 'acme-site',
    })
  })

  it('recusa marker malformado, de outro projeto ou tipo errado', () => {
    for (const value of [
      null,
      undefined,
      42,
      '',
      'je4ndev:pcv2:postgresql_isolated:development',
      'je4ndev:pcv2:supabase_isolated:development:ACME',
      'x:pcv2:postgresql_isolated:development:acme-site',
      'je4ndev:pcv2:postgresql_isolated:PROD:acme-site',
    ]) {
      expect(parseOwnershipMarker(value), String(value)).toBeNull()
    }
  })

  it('recusa marker não derivável do esperado', () => {
    expect(() =>
      ownershipMarkerFor({
        project_id: 'ACME',
        driver: 'postgresql_isolated',
        environment: 'development',
      }),
    ).toThrowError(/identificador invalido/)
  })
})

describe('colisões e adoção', () => {
  it('nome ausente do inventário fica disponível', () => {
    expect(resolveResourceName(desired(), [])).toEqual({
      status: 'available',
      name: 'je4ndev_acme_site_institucional',
    })
  })

  it('adota apenas recurso com ownership compatível', () => {
    const target = desired()
    const existing: ExistingResource = {
      name: target.name,
      project_id: target.project_id,
      driver: target.driver,
      environment: target.environment,
      ownership_marker: target.ownership_marker,
    }
    expect(resolveResourceName(target, [existing])).toEqual({
      status: 'already_satisfied',
      name: target.name,
    })
    expect(ownershipMatches(existing, target)).toBe(true)
  })

  it('falha com NAMING_CONFLICT para recurso de outro projeto', () => {
    const target = desired()
    const foreign: ExistingResource = {
      name: target.name,
      project_id: 'outro-projeto',
      driver: target.driver,
      environment: target.environment,
      ownership_marker:
        'je4ndev:pcv2:postgresql_isolated:development:outro-projeto',
    }
    expect(() => resolveResourceName(target, [foreign])).toThrowError(
      /nome de recurso em conflito/,
    )
    try {
      resolveResourceName(target, [foreign])
    } catch (error) {
      expect((error as { code: string }).code).toBe('NAMING_CONFLICT')
    }
  })

  it('falha quando o marker está ausente ou o ambiente diverge', () => {
    const target = desired()
    const withoutMarker: ExistingResource = {
      name: target.name,
      project_id: target.project_id,
      driver: target.driver,
      environment: target.environment,
      ownership_marker: null,
    }
    const otherEnvironment: ExistingResource = {
      ...withoutMarker,
      environment: 'production',
      ownership_marker: ownershipMarkerFor({
        project_id: target.project_id,
        driver: target.driver,
        environment: 'production',
      }),
    }
    expect(() => resolveResourceName(target, [withoutMarker])).toThrowError(
      /conflito/,
    )
    expect(() => resolveResourceName(target, [otherEnvironment])).toThrowError(
      /conflito/,
    )
  })

  it('recusa ownership marker divergente do derivado server-side', () => {
    const tampered = desired({
      ownership_marker:
        'je4ndev:pcv2:postgresql_isolated:development:acme-outro',
    })
    expect(() => resolveResourceName(tampered, [])).toThrowError(
      /identificador invalido/,
    )
  })

  it('detecta dois recursos resolvendo para o mesmo nome', () => {
    expect(() =>
      assertDistinctNames(['je4ndev_acme_site', 'je4ndev_acme_site']),
    ).toThrowError(/conflito/)
    expect(() =>
      assertDistinctNames(['je4ndev_acme_site', 'je4ndev_acme_outro']),
    ).not.toThrow()
  })

  it('detecta colisão silenciosa de normalização', () => {
    const a = databaseNameFor({ client_id: 'ACME', project_slug: 'Site' })
    const b = databaseNameFor({ client_id: 'acme', project_slug: 'site' })
    expect(a).toBe(b)
    expect(() => assertDistinctNames([a, b])).toThrowError(/conflito/)
  })
})

describe('nomes de Compose do driver Supabase (PR 3)', () => {
  it('deriva rede e data store do Compose project', () => {
    const compose = composeProjectNameFor(INPUT)
    expect(networkNameFor(compose)).toBe(`${compose}-net`)
    expect(dataStoreNameFor(compose)).toBe(`${compose}-postgres-data`)
  })

  it('recusa Compose project vazio', () => {
    expect(() => networkNameFor('')).toThrowError(/identificador invalido/)
    expect(() => dataStoreNameFor(undefined)).toThrowError(
      /identificador invalido/,
    )
  })
})
