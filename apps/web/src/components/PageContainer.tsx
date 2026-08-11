import type { ReactNode } from 'react';

/**
 * Standard page content wrapper (US-18): consistent vertical spacing for the
 * screens rendered inside the AppShell outlet. Keeps per-page markup focused on
 * content, not layout scaffolding.
 */
export default function PageContainer({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-5">{children}</section>;
}
