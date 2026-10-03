import { Link, useNavigate } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import { useAuth } from '../auth/AuthContext';
import { ProfileIcon } from '../components/icons';
import { EconomyStateNotice } from '../components/CustomerEconomy';
import { CreditsCard, IdentityHeader, MembershipCard, SignOutLink } from '../components/account/ProfileCards';
import { spendableCredits, useCustomerEconomy } from '../lib/customerEconomy';
import { membershipView } from '../lib/membership';

/**
 * Profile / Account (US-18; profile redesign).
 *
 * Who you are, what plan you are on, and your Credits -- each said once, from
 * the server's facts, with the one action that makes sense for THIS customer:
 * a Free customer is offered Premium; a Premium customer is never sold what
 * they already have. The Credits balance stays in the app bar on every screen;
 * here it is a card with the way to top up.
 *
 * Only what works is shown. There are no placeholder rows: settings arrive
 * when they exist. Sign out is always reachable, and deliberately quiet.
 */
export default function ProfilePage() {
  const { user, status, logout } = useAuth();
  const navigate = useNavigate();
  const [economyState, retryEconomy] = useCustomerEconomy();
  const membership = membershipView(economyState);
  const credits = economyState.status === 'ready' ? spendableCredits(economyState.overview) : null;
  const showEconomyNotice = economyState.status === 'error' || economyState.status === 'unavailable' || economyState.status === 'disabled';

  async function handleLogout() {
    await logout();
    navigate('/characters', { replace: true });
  }

  if (status === 'loading') {
    // The page's shape while the session is checked -- and no plan, balance or
    // name is claimed before the server has answered.
    return (
      <PageContainer>
        <div aria-busy data-testid="profile-loading" className="flex items-center gap-3">
          <span className="h-12 w-12 shrink-0 animate-pulse rounded-2xl bg-zinc-800/60" />
          <span className="h-5 flex-1 animate-pulse rounded-lg bg-zinc-800/60" />
        </div>
        <MembershipCard view={{ kind: 'loading' }} />
      </PageContainer>
    );
  }

  if (status !== 'authenticated' || !user) {
    return (
      <PageContainer>
        <section data-testid="profile-guest" className="flex items-center gap-3 rounded-3xl border border-zinc-800 bg-zinc-900/50 p-4">
          <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-zinc-800 bg-zinc-900 text-rose-400">
            <ProfileIcon className="h-6 w-6" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white">You're browsing as a guest</p>
            <Link to="/login" className="text-sm font-medium text-rose-400 hover:underline">
              Sign in or create an account →
            </Link>
          </div>
        </section>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <IdentityHeader email={user.email} premium={membership.kind === 'premium'} />
      {showEconomyNotice && <EconomyStateNotice state={economyState} retry={retryEconomy} />}
      <MembershipCard view={membership} />
      <CreditsCard credits={credits} />
      <SignOutLink onSignOut={() => void handleLogout()} />
    </PageContainer>
  );
}
