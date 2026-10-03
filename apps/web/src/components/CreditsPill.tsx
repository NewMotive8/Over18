import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { CreditBalance } from './CustomerEconomy';
import { useCustomerEconomy, type CustomerEconomyClient } from '../lib/customerEconomy';
import { CREDITS_CHANGED_EVENT } from '../lib/creditsStore';

/**
 * The customer's Credit balance, everywhere in the signed-in app (P8.1, and the
 * store-conversion PR): the app bar on ordinary screens, the lobby's top bar,
 * a character's profile, chat and the Posts tab. One tap opens the Credits
 * Store -- no account menu first.
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
export default function CreditsPill({ client, tight = false }: { client?: CustomerEconomyClient; tight?: boolean }) {
  const [state, refresh] = useCustomerEconomy(client);
  const { pathname } = useLocation();
  // The hook already reads on mount; this is for every navigation after it.
  const mounted = useRef(false);

  useEffect(() => {
    if (mounted.current) refresh();
    else mounted.current = true;
  }, [pathname, refresh]);

  // And when a purchase lands without the path changing (the Credits Store's
  // own success screen): the store announces it, the pill asks again.
  useEffect(() => {
    const onChanged = () => refresh();
    window.addEventListener(CREDITS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(CREDITS_CHANGED_EVENT, onChanged);
  }, [refresh]);

  // And when the customer comes back to the tab (a purchase finished elsewhere,
  // a call ended): the balance is the server's, so ask it again.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  if (state.status !== 'ready') return null;
  // CreditBalance renders nothing when the server did not state a balance.
  return <CreditBalance overview={state.overview} compact tight={tight} />;
}
