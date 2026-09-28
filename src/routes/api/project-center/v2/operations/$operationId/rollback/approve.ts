/**
 * `decideProjectRollbackApproval` — `POST .../operations/{id}/rollback/approve`.
 *
 * Segunda fase: aprovação com **novo `approval_id`**, vinculada ao
 * `rollback_plan_hash` (nunca ao `plan_hash` da operação) e segregada do
 * solicitante do rollback. `actor_type != human` ⇒ 403 antes de qualquer
 * efeito.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from '../../index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'decideProjectRollbackApproval'

export function handleDecideProjectRollbackApproval(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId/rollback/approve',
)({
  server: {
    handlers: {
      POST: ({ request }) => handleDecideProjectRollbackApproval(request),
    },
  },
})
