"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function DevPanelClient() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function callAction(path: string, label: string) {
    setBusy(true);
    setStatus(null);
    const res = await fetch(path, { method: "POST" });
    setBusy(false);
    setStatus(res.ok ? `${label} succeeded.` : `${label} failed.`);
    router.refresh();
  }

  async function logOut() {
    await fetch("/api/dev/auth", { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => callAction("/api/dev/seed", "Add 10 test players")}
          className="rounded-full bg-brand-orange px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-brand-orange/90 disabled:opacity-50"
        >
          Add 10 test players
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => callAction("/api/dev/reset", "Remove all test players")}
          className="rounded-full border border-red-900 px-3 py-2 text-sm text-red-400 transition-colors hover:bg-red-950/40 disabled:opacity-50"
        >
          Remove all test players
        </button>
      </div>
      {status && <p className="text-sm text-brand-orange/60">{status}</p>}
      <button type="button" onClick={logOut} className="self-start text-xs text-brand-orange/70 underline hover:text-brand-orange">
        Log out
      </button>
    </div>
  );
}
