import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  buildSupabaseAgentAccessPackage,
  evaluateSupabaseAgentAccess,
} from '../../lib/supabase-agent-access-package'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  createSupabaseRegistryProject,
  formatSupabaseRegistryError,
  listSupabaseRegistryProjects,
} from '../../server/supabase-registry'

export const Route = createFileRoute('/api/supabase-registry')({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const url = new URL(request.url)
          const packageProject = url.searchParams.get('package_project')
          const agent = url.searchParams.get('agent')?.trim()
          const snapshot = listSupabaseRegistryProjects()

          if (!packageProject) {
            return json({ ok: true, data: snapshot })
          }

          const project = snapshot.projects.find(
            (item) => item.slug === packageProject,
          )
          if (!project) {
            return json(
              { ok: false, error: `Project ${packageProject} not found` },
              { status: 404 },
            )
          }

          const access = evaluateSupabaseAgentAccess(project, agent)
          if (!access.allowed) {
            return json({ ok: false, error: access.reason, access }, { status: 403 })
          }

          return json({
            ok: true,
            project: project.slug,
            agent: agent || null,
            access,
            package: buildSupabaseAgentAccessPackage(project, {
              agentName: agent,
              enforceAgentAccess: Boolean(agent),
            }),
          })
        } catch (error) {
          return json(
            { ok: false, error: formatSupabaseRegistryError(error) },
            { status: 500 },
          )
        }
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const body = (await request.json()) as Record<string, unknown>
          const project = createSupabaseRegistryProject(body)
          return json({ ok: true, project }, { status: 201 })
        } catch (error) {
          return json(
            { ok: false, error: formatSupabaseRegistryError(error) },
            { status: 400 },
          )
        }
      },
    },
  },
})
