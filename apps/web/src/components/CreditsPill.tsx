import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
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
 *
 * IT RE-READS ON NAVIGATION (P9). The pill lives in the app bar and outlives
 * every screen, so without this it kept whatever balance it read when the app
 * started -- and after a purchase it contradicted the very page that had just
 * shown the new one. The balance is still the SERVER's: this only decides when
 * to ask again, never what the answer is.
 */
export default function CreditsPill({ client }: { client?: CustomerEconomyClient }) {
  const [state, refresh] = useCustomerEconomy(client);
  const { pathname } = useLocation();
  // The hook already reads on mount; this is for every navigation after it.
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) refresh();
    else mounted.current = true;
  }, [pathname, refresh]);

  if (state.status !== 'ready') return null;
  // CreditBalance renders nothing when the server did not state a balance.
  return <CreditBalance overview={state.overview} compact />;
}
