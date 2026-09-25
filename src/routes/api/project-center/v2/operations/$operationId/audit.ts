/**
 * `listProjectOperationAudit` — `GET .../{id}/audit`.
 *
 * Trilha append-only paginada por cursor. A projeção é sanitizada pelo
 * `redaction.ts` do PR 1: nenhum `SecretRef` sai fora de campo tipado.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from '../index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'listProjectOperationAudit'

export function handleListProjectOperationAudit(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId/audit',
)({
  server: {
    handlers: {
      GET: ({ request }) => handleListProjectOperationAudit(request),
    },
  },
})
