import { createFileRoute } from '@tanstack/react-router'
import {
  handleGitHubWebhook,
  readGitHubSentinelPublicHealth,
} from '../../../server/github-sentinel'

export const Route = createFileRoute('/api/webhooks/github')({
  server: {
    handlers: {
      GET: () => Response.json(readGitHubSentinelPublicHealth()),
      POST: async ({ request }) => handleGitHubWebhook(request),
    },
  },
})
