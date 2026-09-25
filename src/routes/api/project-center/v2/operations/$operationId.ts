/**
 * `getProjectOperation` — `GET /api/project-center/v2/operations/{id}`.
 *
 * Leitura autenticada (`project:read`) da operação projetada: aprovação,
 * rollback, verificação e artefatos vêm dos stores tipados, nunca do plano
 * bruto.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from './index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'getProjectOperation'

export function handleGetProjectOperation(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId',
)({
  server: {
    handlers: {
      GET: ({ request }) => handleGetProjectOperation(request),
    },
  },
})
