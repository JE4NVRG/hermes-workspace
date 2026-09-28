/**
 * `executeProjectRollback` — `POST .../{id}/rollback/execute`.
 *
 * Terceira fase: revalida aprovação, hash, ownership, drift, política e
 * segregação; só então transiciona para `rollback_pending` e enfileira. O
 * lease exclusivo é do PR 6 (`OPEN_LEASE_GUARD` no runtime atual).
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from '../../index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'executeProjectRollback'

export function handleExecuteProjectRollback(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/$operationId/rollback/execute',
)({
  server: {
    handlers: {
      POST: ({ request }) => handleExecuteProjectRollback(request),
    },
  },
})
