/**
 * Testes das projeções puras do Project Center v2 (PR 5).
 *
 * Este módulo é de apresentação: mapeia os 15 estados canônicos do contrato para
 * labels, projeta a timeline a partir do estado persistido e sanitiza qualquer
 * texto antes de ir para DOM/clipboard/toast. Nenhuma função aqui cria estado
 * novo, decide permissão ou monta `SecretRef`.
 */
import { describe, expect, it } from 'vitest'
import type { OperationState } from '@/lib/project-center-v2-types'
import {
  OPERATION_STATE_LABELS,
  approvalPhrase,
  destructionPhrase,
  maskIdempotencyKey,
  maskOpaqueIdentifier,
  maskSecretRef,
  projectTimeline,
  provisioningPhrase,
  rollbackApprovalPhrase,
  sanitizeForDisplay,
} from '@/lib/project-center-v2-types'

/** Fixture sem literal de token no fonte: montada em runtime. */
const SECRET_REF_VALUE = `sref_${'A'.repeat(48)}`
const POSIX_HOME_PATH = ['', 'home', 'operador', '.ssh', 'id_rsa'].join('/')

const CANONICAL_STATES: ReadonlyArray<OperationState> = [
  'planned',
  'awaiting_approval',
  'approved',
  'queued',
  'executing',
  'verifying',
  'succeeded',
  'failed',
  'rollback_pending',
  'rolling_back',
  'rolled_back',
  'manual_intervention_required',
  'rejected',
  'expired',
  'cancelled',
]

describe('catálogo de estados', () => {
  it('cobre exatamente os 15 estados canônicos, sem alias', () => {
    expect(Object.keys(OPERATION_STATE_LABELS).sort()).toEqual(
      [...CANONICAL_STATES].sort(),
    )
    expect(Object.keys(OPERATION_STATE_LABELS)).toHaveLength(15)
    for (const state of CANONICAL_STATES) {
      expect(OPERATION_STATE_LABELS[state]).not.toBe('')
      // Label nunca repete o identificador cru do estado no texto exibido.
      expect(OPERATION_STATE_LABELS[state]).not.toBe(state)
    }
  })
})

describe('sanitizeForDisplay', () => {
  it('mascara SecretRef, credencial, bearer e path absoluto', () => {
    const raw = [
      `ref=${SECRET_REF_VALUE}`,
      `home=${POSIX_HOME_PATH}`,
      'token=super-secreto-123',
      'dsn=postgres://user:senha@10.0.0.1:5432/db',
    ].join('\n')
    const safe = sanitizeForDisplay(raw)

    expect(safe).not.toContain(SECRET_REF_VALUE)
    expect(safe).not.toContain(POSIX_HOME_PATH)
    expect(safe).not.toContain('super-secreto-123')
    expect(safe).not.toContain('senha@10.0.0.1')
    expect(safe).toContain(maskSecretRef())
  })

  it('preserva texto neutro sem alterar', () => {
    expect(sanitizeForDisplay('Plano pronto, sem side effects.')).toBe(
      'Plano pronto, sem side effects.',
    )
  })
})

describe('máscaras', () => {
  it('mantém apenas a cauda como âncora visual', () => {
    const hash = 'c'.repeat(64)
    expect(maskOpaqueIdentifier(hash, 4)).toBe(
      `${'•'.repeat(8)}${'c'.repeat(4)}`,
    )
    expect(maskOpaqueIdentifier(hash, 4)).not.toContain(hash)

    const key = 'Zk9q1Wm4Tb7xLp2Rc5Vh3N'
    expect(maskIdempotencyKey(key)).toBe(`${'•'.repeat(8)}Vh3N`)
    expect(maskIdempotencyKey(key)).not.toContain(key)

    expect(maskSecretRef()).not.toMatch(/[0-9a-f]{8}/)
  })
})

describe('frases de confirmação', () => {
  it('deriva frases determinísticas e específicas por operação', () => {
    const hash = 'd'.repeat(64)
    expect(approvalPhrase('je4ndev-x', hash)).toBe('APROVAR je4ndev-x dddddddd')
    expect(rollbackApprovalPhrase('je4ndev-x', hash)).toBe(
      'APROVAR ROLLBACK je4ndev-x dddddddd',
    )
    expect(provisioningPhrase('je4ndev-x', 'development')).toBe(
      'PROVISIONAR je4ndev-x EM DEVELOPMENT',
    )
    expect(destructionPhrase('je4ndev-x')).toBe(
      'EXCLUIR je4ndev-x SEM RECUPERAÇÃO',
    )
    expect(provisioningPhrase('je4ndev-x', 'production')).not.toBe(
      provisioningPhrase('je4ndev-x', 'development'),
    )
  })
})

describe('projectTimeline', () => {
  it('projeta o passo ativo a partir do estado persistido', () => {
    const executing = projectTimeline({ state: 'executing' })
    expect(executing.filter((step) => step.outcome === 'active')).toHaveLength(
      1,
    )
    const done = projectTimeline({ state: 'succeeded' })
    expect(done.filter((step) => step.outcome === 'pending')).toHaveLength(0)

    // Antes do dry-run nada é dado como concluído.
    const planned = projectTimeline({ state: 'planned' })
    expect(planned.every((step) => step.outcome === 'pending')).toBe(true)
  })

  it('usa latestDetail apenas como detalhe do passo ativo, sanitizado', () => {
    const withDetail = projectTimeline({
      latestDetail: `falha em ${POSIX_HOME_PATH}`,
      state: 'failed',
    })
    const failed = withDetail.filter((step) => step.outcome === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed[0].detail).not.toContain(POSIX_HOME_PATH)
    expect(withDetail.every((step) => step.label !== 'failed')).toBe(true)

    const withoutDetail = projectTimeline({ state: 'failed' })
    expect(withoutDetail.every((step) => step.detail === null)).toBe(true)
  })

  it('estados terminais e negados não deixam passo ativo', () => {
    for (const state of [
      'rejected',
      'expired',
      'rolled_back',
      'cancelled',
      'manual_intervention_required',
    ] as ReadonlyArray<OperationState>) {
      const steps = projectTimeline({ state })
      expect(steps.filter((step) => step.outcome === 'active')).toHaveLength(0)
    }
  })

  it('estado terminal marca o passo onde parou, sem atividade fantasma', () => {
    const steps = projectTimeline({
      latestDetail: 'operação cancelada pelo operador',
      state: 'cancelled',
    })
    const stopped = steps.filter((step) => step.outcome === 'failed')
    expect(stopped).toHaveLength(1)
    expect(stopped[0].detail).toBe('operação cancelada pelo operador')
    expect(
      projectTimeline({ state: 'rejected' }).filter(
        (step) => step.outcome === 'failed',
      ),
    ).toHaveLength(0)
  })
})
