import { useEffect, useState } from 'react';
import { fetchHealth } from '../lib/api';

type ApiStatus = 'checking' | 'online' | 'offline';

export default function HomePage() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking');

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then(() => !cancelled && setApiStatus('online'))
      .catch(() => !cancelled && setApiStatus('offline'));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="flex flex-col items-center gap-6 py-12 text-center">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">
          Welcome to Over<span className="text-rose-500">18</span>
        </h2>
        <p className="mt-2 max-w-xs text-sm text-zinc-400">
          Your AI companion experience. Application shell — features arrive story by story.
        </p>
      </div>

      <div className="flex items-center gap-2 rounded-full border border-zinc-800 px-3 py-1.5 text-xs">
        <span
          className={`h-2 w-2 rounded-full ${
            apiStatus === 'online'
              ? 'bg-emerald-500'
              : apiStatus === 'offline'
                ? 'bg-red-500'
                : 'bg-amber-400 animate-pulse'
          }`}
        />
        <span className="text-zinc-400">
          API {apiStatus === 'checking' ? 'checking…' : apiStatus}
        </span>
      </div>
    </section>
  );
}
