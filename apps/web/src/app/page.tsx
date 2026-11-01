'use client';

import { Shell } from '@/components/shell';
import { useSession } from '@/components/session';

export default function HomePage() {
  const { user } = useSession();
  return (
    <Shell>
      <h1 className="text-2xl font-semibold">Documents</h1>
      <p className="mt-2 text-sm text-slate-500">
        Signed in as {user?.email}. Document upload, sharing and search are being built next.
      </p>
    </Shell>
  );
}
