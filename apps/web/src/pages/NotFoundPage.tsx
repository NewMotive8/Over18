import { Link } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import EmptyState from '../components/EmptyState';

/** Unknown-route fallback (US-18) — never crashes; always offers a way back. */
export default function NotFoundPage() {
  return (
    <PageContainer>
      <EmptyState
        title="Page not found"
        description="This screen doesn't exist (yet). Let's get you back to Discover."
        action={
          <Link
            to="/characters"
            className="rounded-xl bg-rose-600 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-rose-500"
          >
            Back to Discover
          </Link>
        }
      />
    </PageContainer>
  );
}
