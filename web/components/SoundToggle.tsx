"use client";

import { useEffect, useState } from "react";
import { isMuted, playTap, setMuted } from "@/lib/sound";

export default function SoundToggle() {
  const [muted, setMutedState] = useState(true);

  useEffect(() => {
    setMutedState(isMuted());
  }, []);

  function toggle() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playTap();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={muted ? "Unmute interface sounds" : "Mute interface sounds"}
      title={muted ? "Sound off" : "Sound on"}
      className="btn-icon"
    >
      <span aria-hidden="true">{muted ? "🔇" : "🔊"}</span>
    </button>
  );
}
