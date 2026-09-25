/**
 * Testes do catálogo compilado da stack Supabase (PR 3).
 *
 * Provam o que o catálogo promete: toda imagem tem digest (tag só não passa),
 * template/serviço/target fora da allowlist falha fechado, quotas de perfil são
 * consistentes com o orçamento por serviço e o catálogo inteiro é inerte — a
 * redaction canônica é idempotente sobre ele, então nenhum valor sensível
 * (credencial, DSN, token, chave) existe ali.
 */
import { describe, expect, it } from 'vitest'
import { redactValue } from '../redaction'
import {
  IMAGE_DIGEST_PATTERN,
  PINNED_IMAGE_REF_PATTERN,
  SUPABASE_CATALOG_SNAPSHOT,
  SUPABASE_CATALOG_VERSION,
  SUPABASE_DRIFT_FINDINGS,
  SUPABASE_IMAGE_PINS,
  SUPABASE_INTERNAL_PORTS,
  SUPABASE_RESOURCE_PROFILES,
  SUPABASE_SERVICE_IDS,
  SUPABASE_TARGET_IDS,
  SUPABASE_TARGET_KINDS,
  SUPABASE_TEMPLATES,
  SUPABASE_TEMPLATE_ALLOWLIST,
  TARGET_REF_MAX_LENGTH,
  UnknownServiceError,
  UnknownTemplateError,
  UnpinnedImageError,
  assertKnownTemplateId,
  assertPinnedImageRef,
  assertSupabaseServiceId,
  emptyStackProjection,
  imagePinFor,
  internalPortFor,
  isKnownTemplateId,
  isSupabaseServiceId,
  pinnedImageRefFor,
  profileQuota,
  requiredServicesFor,
  resolveResourceProfile,
  resolveTemplateFor,
  supabaseStackProjectionSchema,
  targetPrefixFor,
  targetRefFor,
  unsupportedCapabilities,
} from './supabase-catalog'
import type { SupabaseTemplate } from './supabase-catalog'

const ALL_CAPABILITIES = {
  auth: true,
  storage: true,
  realtime: true,
  postgrest: true,
  backup: true,
} as const

const MARKER = 'je4ndev:pcv2:supabase_isolated:development:acme-site'

describe('imagens pinadas por digest', () => {
  it('pina todos os serviços com digest sha256 de 64 hex', () => {
    for (const service of SUPABASE_SERVICE_IDS) {
      const pin = SUPABASE_IMAGE_PINS[service]
      expect(pin.service, service).toBe(service)
      expect(IMAGE_DIGEST_PATTERN.test(pin.digest), service).toBe(true)
      const ref = pinnedImageRefFor(service)
      expect(PINNED_IMAGE_REF_PATTERN.test(ref), ref).toBe(true)
      expect(ref).toBe(`${pin.repository}@${pin.digest}`)
      expect(ref).not.toContain(':latest')
    }
    expect(SUPABASE_SERVICE_IDS).toHaveLength(6)
  })

  it('recusa imagem sem digest e repositório fora do catálogo', () => {
    expect(() => assertPinnedImageRef('supabase/postgres:15.14.1.176')).toThrow(
      UnpinnedImageError,
    )
    expect(() =>
      assertPinnedImageRef(`supabase/postgres@sha256:${'z'.repeat(64)}`),
    ).toThrow(UnpinnedImageError)
    expect(() =>
      assertPinnedImageRef(`outro/postgres@sha256:${'a'.repeat(64)}`),
    ).toThrow(UnpinnedImageError)
    expect(() => assertPinnedImageRef('')).toThrow(UnpinnedImageError)
    try {
      assertPinnedImageRef('supabase/postgres:15.14.1.176')
    } catch (error) {
      expect((error as UnpinnedImageError).code).toBe('POLICY_DENIED')
    }
  })

  it('aceita somente a referência exata do catálogo', () => {
    const ref = pinnedImageRefFor('postgres')
    expect(assertPinnedImageRef(ref)).toBe(ref)
    expect(() => imagePinFor('servico-desconhecido')).toThrow(
      UnknownServiceError,
    )
    expect(isSupabaseServiceId('postgres')).toBe(true)
    expect(isSupabaseServiceId('postgres ')).toBe(false)
    expect(() => assertSupabaseServiceId(null)).toThrow(UnknownServiceError)
  })
})

describe('templates permitidos', () => {
  it('mantém a allowlist fechada e cobrindo as capabilities do contrato', () => {
    expect(SUPABASE_TEMPLATE_ALLOWLIST).toEqual(['sb-stack-full'])
    expect(SUPABASE_TEMPLATES).toHaveLength(1)
    const template = SUPABASE_TEMPLATES[0]
    expect(template.capabilities).toEqual([
      'auth',
      'storage',
      'realtime',
      'postgrest',
      'backup',
    ])
    expect(template.services).toEqual([...SUPABASE_SERVICE_IDS])
    expect(isKnownTemplateId('sb-stack-full')).toBe(true)
  })

  it('recusa template desconhecido com POLICY_DENIED', () => {
    expect(() => assertKnownTemplateId('sb-stack-unknown')).toThrow(
      UnknownTemplateError,
    )
    try {
      assertKnownTemplateId('sb-stack-unknown')
    } catch (error) {
      expect((error as UnknownTemplateError).code).toBe('POLICY_DENIED')
      expect((error as UnknownTemplateError).value).toBe('sb-stack-unknown')
    }
  })

  it('resolve o template pelas capabilities pedidas', () => {
    expect(resolveTemplateFor(ALL_CAPABILITIES)?.template_id).toBe(
      'sb-stack-full',
    )
    expect(resolveTemplateFor({ backup: true })?.template_id).toBe(
      'sb-stack-full',
    )
  })

  it('sem candidato, reporta a capability como não suportada', () => {
    const restrictivo: SupabaseTemplate = {
      template_id: 'sb-stack-full',
      version: '2026.09',
      capabilities: ['backup'],
      services: ['postgres', 'gateway'],
    }
    expect(resolveTemplateFor(ALL_CAPABILITIES, [restrictivo])).toBeUndefined()
    expect(unsupportedCapabilities(ALL_CAPABILITIES, restrictivo)).toEqual([
      'auth',
      'storage',
      'realtime',
      'postgrest',
    ])
  })

  it('deriva os serviços exigidos na ordem canônica', () => {
    expect(requiredServicesFor({ backup: true })).toEqual([
      'postgres',
      'gateway',
    ])
    expect(
      requiredServicesFor({
        auth: true,
        storage: true,
        realtime: false,
        postgrest: false,
        backup: true,
      }),
    ).toEqual(['postgres', 'gotrue', 'storage-api', 'gateway'])
    expect(requiredServicesFor(ALL_CAPABILITIES)).toEqual([
      ...SUPABASE_SERVICE_IDS,
    ])
  })
})

describe('portas internas (target IDs)', () => {
  it('tem allowlist fechada, única e em faixa válida', () => {
    const ports = SUPABASE_SERVICE_IDS.map((service) =>
      internalPortFor(service),
    )
    for (const port of ports) {
      expect(Number.isInteger(port)).toBe(true)
      expect(port).toBeGreaterThan(0)
      expect(port).toBeLessThanOrEqual(65535)
    }
    expect(new Set(ports).size).toBe(ports.length)
    expect(Object.keys(SUPABASE_INTERNAL_PORTS).sort()).toEqual(
      [...SUPABASE_SERVICE_IDS].sort(),
    )
    expect(() => internalPortFor('servico-desconhecido')).toThrow(
      UnknownServiceError,
    )
  })

  it('mantém prefixos de target para todos os kinds conhecidos', () => {
    expect(Object.keys(SUPABASE_TARGET_IDS).sort()).toEqual(
      [...SUPABASE_TARGET_KINDS].sort(),
    )
    for (const kind of SUPABASE_TARGET_KINDS) {
      expect(targetPrefixFor(kind).length).toBeGreaterThan(0)
    }
    expect(() => targetPrefixFor('kind-desconhecido')).toThrow(/allowlist/)
  })

  it('monta target_ref com o ownership marker esperado', () => {
    const ref = targetRefFor({
      kind: 'network',
      name: 'je4ndev-sb-acme-site-net',
      ownership_marker: MARKER,
    })
    expect(ref).toBe(`network:je4ndev-sb-acme-site-net#${MARKER}`)
    expect(ref.length).toBeLessThanOrEqual(TARGET_REF_MAX_LENGTH)
  })

  it('recusa nome livre, path, curinga e ref acima do limite', () => {
    for (const name of [
      '/etc/passwd',
      'a b',
      'a#b',
      '../outro',
      'a\\b',
      '',
      'a'.repeat(121),
    ]) {
      expect(() =>
        targetRefFor({ kind: 'network', name, ownership_marker: MARKER }),
      ).toThrow(/target_ref|recurso/)
    }
    expect(() =>
      targetRefFor({
        kind: 'network',
        name: 'ok',
        ownership_marker: 'a'.repeat(141),
      }),
    ).toThrow(/ownership marker/)
    expect(() =>
      targetRefFor({
        kind: 'network',
        name: 'b'.repeat(120),
        ownership_marker: 'm'.repeat(140),
      }),
    ).toThrow(/limite do contrato/)
  })

  it('comporta slugs no limite máximo do contrato', () => {
    const client = `c${'a'.repeat(23)}`
    const project = `p${'b'.repeat(23)}`
    const longMarker = `je4ndev:pcv2:supabase_isolated:production:${client}-${project}`
    for (const kind of SUPABASE_TARGET_KINDS) {
      const ref = targetRefFor({
        kind,
        name:
          kind === 'backup-policy' || kind === 'r2-prefix'
            ? `${client}-${project}/production/postgres/`
            : `${client}-${project}`,
        ownership_marker: longMarker,
      })
      expect(ref.length, kind).toBeLessThanOrEqual(TARGET_REF_MAX_LENGTH)
    }
  })
})

describe('perfis de recurso', () => {
  it('é consistente com o orçamento declarado por serviço', () => {
    expect(
      SUPABASE_RESOURCE_PROFILES.map((profile) => profile.profile_id),
    ).toEqual(['sb-small', 'sb-standard'])
    for (const profile of SUPABASE_RESOURCE_PROFILES) {
      const cpu = SUPABASE_SERVICE_IDS.reduce(
        (total, service) => total + profile.services[service].cpu_millicores,
        0,
      )
      const memory = SUPABASE_SERVICE_IDS.reduce(
        (total, service) => total + profile.services[service].memory_mb,
        0,
      )
      expect(profile.cpu_millicores.min, profile.profile_id).toBe(cpu)
      expect(profile.memory_mb.min, profile.profile_id).toBe(memory)
      expect(profile.cpu_millicores.default).toBeGreaterThanOrEqual(cpu)
      expect(profile.memory_mb.default).toBeGreaterThanOrEqual(memory)
    }
  })

  it('escolhe o menor perfil que comporta o pedido', () => {
    expect(resolveResourceProfile(undefined)?.profile_id).toBe('sb-small')
    expect(resolveResourceProfile({})?.profile_id).toBe('sb-small')
    expect(resolveResourceProfile({ cpu_millicores: 4000 })?.profile_id).toBe(
      'sb-small',
    )
    expect(resolveResourceProfile({ cpu_millicores: 4001 })?.profile_id).toBe(
      'sb-standard',
    )
    expect(resolveResourceProfile({ memory_mb: 10240 })?.profile_id).toBe(
      'sb-small',
    )
    expect(resolveResourceProfile({ memory_mb: 10241 })?.profile_id).toBe(
      'sb-standard',
    )
    // Acima do maior perfil: sem candidato (o driver devolve QUOTA_EXCEEDED).
    expect(resolveResourceProfile({ memory_mb: 16385 })).toBeUndefined()
    expect(resolveResourceProfile({ database_size_mb: 102401 })).toBeUndefined()
  })

  it('expõe as quotas do perfil escolhido', () => {
    const profile = SUPABASE_RESOURCE_PROFILES[1]
    expect(profileQuota(profile, 'cpu_millicores')).toBe(profile.cpu_millicores)
    expect(profileQuota(profile, 'data_store_mb').max).toBe(102400)
    expect(profileQuota(profile, 'backup_retention_days').max).toBe(90)
  })
})

describe('catálogo sem valor sensível', () => {
  it('é idempotente sob a redaction canônica', () => {
    const plain = JSON.parse(
      JSON.stringify(SUPABASE_CATALOG_SNAPSHOT),
    ) as Record<string, unknown>
    expect(redactValue(plain)).toEqual(plain)
  })

  it('não contém DSN, token, chave, path absoluto nem segredo', () => {
    const json = JSON.stringify(SUPABASE_CATALOG_SNAPSHOT)
    expect(json).not.toContain('sref_')
    expect(json).not.toContain('password')
    expect(json).not.toContain('BEGIN')
    expect(json).not.toContain('://')
    expect(json).not.toContain('0.0.0.0')
    expect(json).not.toMatch(/\/home\/|\/root\/|\/etc\/|\/var\/|\/srv\//)
    expect(SUPABASE_CATALOG_SNAPSHOT.catalog_version).toBe(
      SUPABASE_CATALOG_VERSION,
    )
    expect(SUPABASE_CATALOG_SNAPSHOT.images).toHaveLength(
      SUPABASE_SERVICE_IDS.length,
    )
  })
})

describe('projeção de stack fail-closed', () => {
  it('sem observação, nada existe e nada é adotado', () => {
    const empty = emptyStackProjection({
      compose_project: 'je4ndev-sb-acme-site',
      network: 'je4ndev-sb-acme-site-net',
      data_store: 'je4ndev-sb-acme-site-postgres-data',
      expected_template_id: 'sb-stack-full',
    })
    expect(() => supabaseStackProjectionSchema.parse(empty)).not.toThrow()
    expect(empty.compose_project.exists).toBe(false)
    expect(empty.network.ownership_verified).toBe(false)
    expect(empty.data_store.exists).toBe(false)
    expect(empty.ownership_verified).toBe(false)
    expect(empty.template_complete).toBe(false)
    expect(empty.drift_findings).toEqual([])
    expect(empty.services).toEqual([])
  })

  it('recusa campo desconhecido e enum fora do vocabulário', () => {
    const empty = emptyStackProjection({
      compose_project: 'je4ndev-sb-acme-site',
      network: 'je4ndev-sb-acme-site-net',
      data_store: 'je4ndev-sb-acme-site-postgres-data',
      expected_template_id: 'sb-stack-full',
    })
    expect(() =>
      supabaseStackProjectionSchema.parse({ ...empty, host_path: '/srv' }),
    ).toThrow()
    expect(() =>
      supabaseStackProjectionSchema.parse({
        ...empty,
        drift_findings: ['achado-inventado'],
      }),
    ).toThrow()
    expect(SUPABASE_DRIFT_FINDINGS).toContain('capacity_exceeded')
  })
})
