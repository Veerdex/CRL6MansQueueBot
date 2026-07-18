"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { playError, playSuccess, playTap } from "@/lib/sound";

export default function DevPanelClient() {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function callAction(path: string, label: string) {
    playTap();
    setBusy(true);
    setStatus(null);
    const res = await fetch(path, { method: "POST" });
    setBusy(false);
    if (res.ok) {
      playSuccess();
      setStatus(`${label} succeeded.`);
    } else {
      playError();
      setStatus(`${label} failed.`);
    }
    router.refresh();
  }

  async function logOut() {
    playTap();
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
          className="btn-accent px-3 py-2 text-sm"
        >
          Add 10 test players
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => callAction("/api/dev/reset", "Remove all test players")}
          className="btn-danger px-3 py-2 text-sm disabled:opacity-50"
        >
          Remove all test players
        </button>
      </div>
      {status && <p className="text-sm text-muted">{status}</p>}
      <button type="button" onClick={logOut} className="self-start text-xs text-muted underline hover:text-foreground">
        Log out
      </button>
    </div>
  );
}
