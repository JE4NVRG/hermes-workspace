/**
 * `verifyProjectOperation` — `POST .../{id}/verify`.
 *
 * Enfileira a verificação (outbox `verify`) sem estado novo: a operação
 * precisa já ter terminado (`succeeded`/`failed`). Nada é executado aqui.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from '../index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'verifyProjectOperation'

export function handleVerifyProjectOperation(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId/verify',
)({
  server: {
    handlers: {
      POST: ({ request }) => handleVerifyProjectOperation(request),
    },
  },
})
