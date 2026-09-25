/**
 * Composition root das rotas v2 do Project Center (PR 4).
 *
 * Este arquivo **não** é uma rota: o gerador do router ignora arquivos que não
 * exportam `Route`, então o barrel pode expor a stack de runtime sem virar
 * superfície HTTP.
 *
 * Nenhum adapter privilegiado é registrado aqui. As portas de observação, de
 * verificação de token e de rate limit nascem **fechadas/abertas conforme o
 * contrato**, e só um deployment autorizado injeta implementações reais:
 *
 * - `createDenyAllVerifier()` ⇒ sem provedor de token scoped, 401 em tudo;
 * - `createClosedObservationPort()` ⇒ dry-run não observa nada sem adapter;
 * - `createClosedRollbackPlanningPort()` ⇒ rollback recusa (422) sem adapter;
 * - `OPEN_LEASE_GUARD` ⇒ lease exclusivo é do PR 6 (aqui sempre livre);
 * - `InMemoryRateLimitPort` ⇒ 429 determinístico por token/operação.
 *
 * A stack de stores é in-memory de propósito: o PR 4 não abre banco. O
 * adapter durável entra na integração (PR 6/7) implementando as mesmas
 * interfaces.
 */
import type { Driver } from '@/server/project-center-v2/domain'
import type { DryRunDriver } from '@/server/project-center-v2/drivers/types'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import {
  createClosedRollbackPlanningPort,
  createInMemoryOperationApprovalStore,
  createInMemoryOperationOwnershipStore,
  createInMemoryRollbackPlanStore,
} from '@/server/project-center-v2/approval-service'
import { createInMemoryAuditStore } from '@/server/project-center-v2/audit-store'
import { postgresqlIsolatedDriver } from '@/server/project-center-v2/drivers/postgresql-isolated'
import { supabaseIsolatedDriver } from '@/server/project-center-v2/drivers/supabase-isolated'
import { resolveProjectCenterV2Flags } from '@/server/project-center-v2/feature-flags'
import {
  InMemoryRateLimitPort,
  OPEN_LEASE_GUARD,
  PROJECT_CENTER_V2_MUTATIONS,
  PROJECT_CENTER_V2_OPERATIONS_PATH,
  PROJECT_CENTER_V2_ROUTES,
  createClosedObservationPort,
  createDenyAllVerifier,
  handleProjectCenterV2Request,
} from '@/server/project-center-v2/http'
import {
  createIdempotencyStore,
  createInMemoryOutboxStore,
} from '@/server/project-center-v2/idempotency'
import { createInMemoryOperationStore } from '@/server/project-center-v2/operation-store'

export {
  PROJECT_CENTER_V2_MUTATIONS,
  PROJECT_CENTER_V2_OPERATIONS_PATH,
  PROJECT_CENTER_V2_ROUTES,
}

/**
 * Registro de drivers do dry-run da API v2. Diferente do `DRIVER_REGISTRY`
 * global do PR 2 (congelado na asserção daquele elo), aqui os dois drivers
 * allowlisted convivem — a seleção continua sendo por `intent.driver`.
 */
const PROJECT_CENTER_V2_DRIVER_REGISTRY: Readonly<
  Partial<Record<Driver, DryRunDriver>>
> = Object.freeze({
  postgresql_isolated: postgresqlIsolatedDriver,
  supabase_isolated: supabaseIsolatedDriver,
})

interface ProjectCenterV2RuntimeStack {
  readonly operations: ReturnType<typeof createInMemoryOperationStore>
  readonly audit: ReturnType<typeof createInMemoryAuditStore>
  readonly outbox: ReturnType<typeof createInMemoryOutboxStore>
  readonly idempotency: ReturnType<typeof createIdempotencyStore>
  readonly approvals: ReturnType<typeof createInMemoryOperationApprovalStore>
  readonly rollbackPlans: ReturnType<typeof createInMemoryRollbackPlanStore>
  readonly ownership: ReturnType<typeof createInMemoryOperationOwnershipStore>
}

let runtimeStack: ProjectCenterV2RuntimeStack | null = null

/**
 * Stack in-memory única do processo. Criada na primeira requisição para não
 * alocar nada em quem só importa o módulo (ex.: testes de contrato, build).
 */
function runtimeStackOrCreate(): ProjectCenterV2RuntimeStack {
  if (runtimeStack !== null) return runtimeStack
  const operations = createInMemoryOperationStore()
  const audit = createInMemoryAuditStore()
  const outbox = createInMemoryOutboxStore()
  runtimeStack = {
    operations,
    audit,
    outbox,
    idempotency: createIdempotencyStore({ operations, audit, outbox }),
    approvals: createInMemoryOperationApprovalStore(),
    rollbackPlans: createInMemoryRollbackPlanStore(),
    ownership: createInMemoryOperationOwnershipStore(),
  }
  return runtimeStack
}

const runtimeRateLimiter = new InMemoryRateLimitPort()

/**
 * Dependências do runtime. As flags são resolvidas a cada requisição: ligar ou
 * desligar a superfície **não** exige reiniciar o processo.
 */
export function resolveProjectCenterV2Deps(): ProjectCenterV2Deps {
  const stack = runtimeStackOrCreate()
  return {
    flags: resolveProjectCenterV2Flags(),
    verifier: createDenyAllVerifier(),
    operations: stack.operations,
    audit: stack.audit,
    idempotency: stack.idempotency,
    outbox: stack.outbox,
    approvals: stack.approvals,
    rollbackPlans: stack.rollbackPlans,
    ownership: stack.ownership,
    observations: createClosedObservationPort(),
    rollbackObservations: createClosedRollbackPlanningPort(),
    drivers: PROJECT_CENTER_V2_DRIVER_REGISTRY,
    lease: OPEN_LEASE_GUARD,
    rateLimiter: runtimeRateLimiter,
  }
}

/** Ponto único usado pelas rotas irmãs; mantém o middleware em um só lugar. */
export function handleProjectCenterV2Operation(
  request: Request,
): Promise<Response> {
  return handleProjectCenterV2Request(request, resolveProjectCenterV2Deps())
}
