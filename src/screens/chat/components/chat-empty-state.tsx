import { HugeiconsIcon } from '@hugeicons/react'
import { BrainIcon, CodeIcon, PuzzleIcon } from '@hugeicons/core-free-icons'
import { motion } from 'motion/react'

type SuggestionChip = {
  label: string
  description: string
  prompt: string
  icon: unknown
}

const SUGGESTIONS: Array<SuggestionChip> = [
  {
    label: 'Analyze workspace',
    description: 'Find risks and next steps in this repo.',
    prompt:
      'Analyze this workspace structure and give me 3 engineering risks. Use tools and keep it concise.',
    icon: CodeIcon,
  },
  {
    label: 'Save a preference',
    description: 'Store a working preference in memory.',
    prompt:
      'Save this to memory exactly: "For demos, respond in 3 bullets max and put risk first." Then confirm saved.',
    icon: BrainIcon,
  },
  {
    label: 'Create a file',
    description: 'Generate a small starter artifact.',
    prompt: 'Create demo-checklist.md with 5 launch checks for this app.',
    icon: PuzzleIcon,
  },
]

type ChatEmptyStateProps = {
  onSuggestionClick?: (prompt: string) => void
  compact?: boolean
}

export function ChatEmptyState({
  onSuggestionClick,
  compact = false,
}: ChatEmptyStateProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className="flex h-full flex-col items-center justify-center px-4 py-6"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border p-5 text-center shadow-sm md:p-6"
        style={{
          background: 'var(--theme-card)',
          borderColor: 'var(--theme-border)',
        }}
      >
        <img
          src="/claude-avatar.webp"
          alt="Hermes Agent"
          className="mx-auto size-16 rounded-xl"
          style={{
            border: '1px solid var(--theme-border)',
            padding: '4px',
            background: 'var(--theme-bg)',
          }}
        />

        <p className="micro-label mt-4" style={{ color: 'var(--theme-muted)' }}>
          Hermes Workspace
        </p>
        <h2
          className={compact ? 'mt-1 text-2xl font-semibold' : 'mt-1 text-3xl font-semibold'}
          style={{ color: 'var(--theme-text)' }}
        >
          What should we work on?
        </h2>

        {!compact ? (
          <p className="mx-auto mt-3 max-w-lg text-sm leading-6" style={{ color: 'var(--theme-muted)' }}>
            Start with a prompt below or type your own request. Hermes can inspect
            files, run tools, save preferences, and create artifacts in this workspace.
          </p>
        ) : null}

        <div className="mt-5 grid gap-2 text-left md:grid-cols-3">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion.label}
              type="button"
              onClick={() => onSuggestionClick?.(suggestion.prompt)}
              className="group flex min-h-24 cursor-pointer flex-col gap-2 rounded-xl border px-3 py-3 text-left transition-colors hover:border-accent-400/70 hover:bg-primary-200/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
              style={{
                background: 'var(--theme-card2)',
                borderColor: 'var(--theme-border)',
                color: 'var(--theme-text)',
              }}
            >
              <span className="flex items-center gap-2 text-sm font-semibold">
                <span className="inline-flex size-8 items-center justify-center rounded-lg bg-accent-500/10 text-accent-500">
                  <HugeiconsIcon
                    icon={suggestion.icon as any}
                    size={17}
                    strokeWidth={1.6}
                  />
                </span>
                {suggestion.label}
              </span>
              <span className="text-xs leading-5" style={{ color: 'var(--theme-muted)' }}>
                {suggestion.description}
              </span>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  )
}
