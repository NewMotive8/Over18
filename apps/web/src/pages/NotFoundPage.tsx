import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <section className="flex flex-col items-center gap-4 py-16 text-center">
      <h2 className="text-2xl font-semibold">Page not found</h2>
      <Link to="/" className="text-sm text-rose-500 hover:underline">
        Back to home
      </Link>
    </section>
  );
}
