/**
 * `createProjectRollbackDryRun` — `POST .../{id}/rollback/dry-run`.
 *
 * Primeira fase do rollback: observa o estado (porta injetada) e emite
 * `RollbackPlan` tipado com `rollback_plan_hash` próprio. Ownership não
 * comprovado ou drift ⇒ 422 `ROLLBACK_NOT_SAFE`, sem plano.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from '../../index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'createProjectRollbackDryRun'

export function handleCreateProjectRollbackDryRun(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId/rollback/dry-run',
)({
  server: {
    handlers: {
      POST: ({ request }) => handleCreateProjectRollbackDryRun(request),
    },
  },
})
