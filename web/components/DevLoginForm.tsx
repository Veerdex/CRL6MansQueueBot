"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function DevLoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/dev/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setSubmitting(false);
    if (res.ok) {
      router.refresh();
    } else {
      setError("Incorrect password.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
        autoFocus
        className="rounded-lg border border-zinc-700 bg-black px-3 py-2 text-sm text-brand-orange outline-none placeholder:text-brand-orange/40 focus:border-brand-orange"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded-full bg-brand-orange px-3 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-brand-orange/90 disabled:opacity-50"
      >
        {submitting ? "Checking…" : "Enter"}
      </button>
    </form>
  );
}
