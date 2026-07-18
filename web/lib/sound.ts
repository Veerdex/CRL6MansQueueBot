"use client";

const STORAGE_KEY = "crl6mans_sound_muted";

let audioCtx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const AudioCtxClass = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtxClass) return null;
    audioCtx = new AudioCtxClass();
  }
  if (audioCtx.state === "suspended") {
    void audioCtx.resume();
  }
  return audioCtx;
}

export function isMuted(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(STORAGE_KEY) === "1";
}

export function setMuted(value: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, value ? "1" : "0");
}

function tone(
  freq: number,
  duration: number,
  opts: { type?: OscillatorType; gain?: number; delay?: number; sweepTo?: number } = {},
) {
  if (isMuted()) return;
  const ctx = getContext();
  if (!ctx) return;

  const { type = "sine", gain = 0.05, delay = 0, sweepTo } = opts;
  const start = ctx.currentTime + delay;

  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  if (sweepTo) {
    osc.frequency.exponentialRampToValueAtTime(sweepTo, start + duration);
  }

  gainNode.gain.setValueAtTime(0, start);
  gainNode.gain.linearRampToValueAtTime(gain, start + 0.008);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, start + duration);

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** Quiet click — button presses, tab switches. */
export function playTap() {
  tone(720, 0.06, { type: "sine", gain: 0.045 });
}

/** Light rising sweep — opening a panel/menu. */
export function playWhoosh() {
  tone(320, 0.18, { type: "sine", gain: 0.03, sweepTo: 900 });
}

/** Two-note ascending chime — confirmations, successful actions. */
export function playSuccess() {
  tone(660, 0.12, { type: "sine", gain: 0.05 });
  tone(880, 0.16, { type: "sine", gain: 0.05, delay: 0.09 });
}

/** Muted low descending tone — errors, failures. */
export function playError() {
  tone(220, 0.22, { type: "sine", gain: 0.055, sweepTo: 140 });
}
