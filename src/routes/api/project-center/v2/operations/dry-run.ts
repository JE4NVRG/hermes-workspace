/**
 * `createProjectDryRun` — `POST /api/project-center/v2/operations/dry-run`.
 *
 * Cria a operação em `awaiting_approval` com plano determinístico, chave de
 * idempotência client-owned e auditoria append-only, tudo no mesmo commit.
 */
import { createFileRoute } from '@tanstack/react-router'
import { resolveProjectCenterV2Deps } from './index'
import type { ProjectCenterV2Deps } from '@/server/project-center-v2/http'
import { handleProjectCenterV2Request } from '@/server/project-center-v2/http'

export const OPERATION_ID = 'createProjectDryRun'

export function handleCreateProjectDryRun(
  request: Request,
  deps: ProjectCenterV2Deps = resolveProjectCenterV2Deps(),
): Promise<Response> {
  return handleProjectCenterV2Request(request, deps)
}

export const Route = createFileRoute(
  '/api/project-center/v2/operations/dry-run',
)({
  server: {
    handlers: {
      POST: ({ request }) => handleCreateProjectDryRun(request),
    },
  },
})
