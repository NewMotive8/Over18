import { Link } from 'react-router-dom';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import { CreditBalance, EconomyStateNotice, PlanSummary } from '../components/CustomerEconomy';
import { spendableCredits, useCustomerEconomy } from '../lib/customerEconomy';

/**
 * Wallet -- the customer's balance, read-only.
 *
 * The balance appears only when the server supplies it. There is no wallet
 * activity endpoint yet, so activity is stated as unavailable rather than
 * shown as an empty list.
 */
export default function WalletPage() {
  const [state, retry] = useCustomerEconomy();
  return (
    <PageContainer>
      <PageHeader eyebrow="Account" title="Wallet" subtitle="See your available Credits and activity in one place." />
      <EconomyStateNotice state={state} retry={retry} />
      {state.status === 'ready' && (
        <>
          <div className="rounded-3xl border border-amber-500/20 bg-gradient-to-b from-amber-500/15 to-zinc-950 p-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-300">Available now</p>
            {spendableCredits(state.overview) === null ? (
              <p className="mt-2 text-sm text-zinc-400">Your Credit balance isn't available yet.</p>
            ) : (
              <div className="mt-2"><CreditBalance overview={state.overview} /></div>
            )}
            <p className="mt-3 text-sm text-zinc-400">Your balance is supplied by your account. Credits are not purchased or spent in this preview.</p>
          </div>
          <PlanSummary overview={state.overview} />
          <section>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Activity</h3>
            <div className="mt-2 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5 text-sm text-zinc-400">Wallet activity isn't available yet.</div>
          </section>
          <Link to="/subscription" className="text-center text-sm text-zinc-400 hover:text-zinc-200">View plans and benefits →</Link>
        </>
      )}
    </PageContainer>
  );
}
