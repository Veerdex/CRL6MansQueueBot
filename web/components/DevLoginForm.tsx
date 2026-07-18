"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { playError, playSuccess, playTap } from "@/lib/sound";

export default function DevLoginForm() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    playTap();
    setSubmitting(true);
    setError(null);
    const res = await fetch("/api/dev/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setSubmitting(false);
    if (res.ok) {
      playSuccess();
      router.refresh();
    } else {
      playError();
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
        className="field px-3 py-2 text-sm text-foreground placeholder:text-muted"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button type="submit" disabled={submitting} className="btn-accent px-3 py-2 text-sm">
        {submitting ? "Checking…" : "Enter"}
      </button>
    </form>
  );
}
