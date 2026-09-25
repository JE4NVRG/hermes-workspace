/**
 * `decideProjectOperationApproval` — `POST .../operations/{id}/approve`.
 *
 * Decisão `oneOf` (approve/reject) vinculada ao `plan_hash` e à `If-Match`
 * (revision) da operação. `actor_type != human` é recusado antes de qualquer
 * efeito (segregação de ator).
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from '../index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'decideProjectOperationApproval'

export function handleDecideProjectOperationApproval(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId/approve',
)({
  server: {
    handlers: {
      POST: ({ request }) => handleDecideProjectOperationApproval(request),
    },
  },
})
