import { createFileRoute } from '@tanstack/react-router'
import { usePageTitle } from '@/hooks/use-page-title'
import { SupabaseProjectsScreen } from '@/screens/supabase/supabase-projects-screen'

export const Route = createFileRoute('/supabase')({
  ssr: false,
  component: function SupabaseProjectsRoute() {
    usePageTitle('Supabase Projects')
    return <SupabaseProjectsScreen />
  },
})
