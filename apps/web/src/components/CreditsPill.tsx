import { CreditBalance } from './CustomerEconomy';
import { useCustomerEconomy, type CustomerEconomyClient } from '../lib/customerEconomy';

/**
 * The customer's Credit balance, wherever they might spend Credits (P8.1, from
 * the customer UX specification): the app bar on ordinary screens, and the
 * Posts tab, where Credit-priced content is.
 *
 * It shows the server's spendable balance and nothing else -- no wallet, no
 * classes, no reserved amount, no ledger. When the balance is not known, or the
 * economy is off, it renders NOTHING rather than a zero: an absent pill is the
 * app exactly as it is today.
 */
export default function CreditsPill({ client }: { client?: CustomerEconomyClient }) {
  const [state] = useCustomerEconomy(client);
  if (state.status !== 'ready') return null;
  // CreditBalance renders nothing when the server did not state a balance.
  return <CreditBalance overview={state.overview} compact />;
}
