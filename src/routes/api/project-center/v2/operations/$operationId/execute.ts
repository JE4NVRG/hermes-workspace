/**
 * `executeProjectOperation` — `POST .../{id}/execute`.
 *
 * Só enfileira (outbox) e transiciona para `queued` com a aprovação válida.
 * Com `PROJECT_CENTER_V2_WORKER_ENABLED=false` nenhuma ação privilegiada
 * acontece: nenhum executor é instanciado, nenhum lease é adquirido.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from '../index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'executeProjectOperation'

export function handleExecuteProjectOperation(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId/execute',
)({
  server: {
    handlers: {
      POST: ({ request }) => handleExecuteProjectOperation(request),
    },
  },
})
