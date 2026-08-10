import { Link } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { GoSteadyIcon } from '../components/icons';

/**
 * Go Steady (US-18) — a first-class product area for the future persistent /
 * relationship experience. US-18 ships the navigation + an intentional, polished
 * future-state ONLY. No relationship/persistent-character logic is implemented
 * here (that is later product work); this screen is architecturally ready to
 * receive real content without a redesign.
 */
export default function GoSteadyPage() {
  return (
    <PageContainer>
      <PageHeader
        eyebrow="Relationships"
        title="Go Steady"
        subtitle="Where your closer connections will live."
      />

      <EmptyState
        icon={<GoSteadyIcon className="h-6 w-6" />}
        title="No steady connections yet"
        description="When you get closer to a character, they'll show up here — your ongoing companions, in one place."
        badge="Coming soon"
        action={
          <Link
            to="/characters"
            className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
          >
            Discover characters
          </Link>
        }
      />
    </PageContainer>
  );
}
