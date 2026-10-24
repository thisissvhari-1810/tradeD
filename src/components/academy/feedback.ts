"use client";

import { useSyncExternalStore } from "react";

/**
 * Academy sound and haptic cues. Sound starts off and only plays after the learner switches it on
 * (itself a tap, so the browser allows audio); vibration is used only where the device supports it.
 * The tones are synthesised with Web Audio, so there are no sound files to download. Preferences are
 * kept on this device.
 */

export type FeedbackPrefs = { sound: boolean; haptics: boolean };
export type Cue = "select" | "correct" | "wrong" | "complete";

const KEY = "td-academy-feedback";
const DEFAULT: FeedbackPrefs = { sound: false, haptics: true };
const listeners = new Set<() => void>();
let cache: FeedbackPrefs | null = null;

function read(): FeedbackPrefs {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<FeedbackPrefs>) : {};
    cache = { sound: parsed.sound === true, haptics: parsed.haptics !== false };
  } catch {
    cache = DEFAULT;
  }
  return cache;
}

export function setFeedbackPrefs(next: Partial<FeedbackPrefs>) {
  cache = { ...read(), ...next };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage unavailable: kept for this visit */ }
  listeners.forEach((listener) => listener());
  if (next.sound) cue("select");
}

export function useFeedbackPrefs() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    read,
    () => DEFAULT,
  );
}

/** [frequency Hz, start s, duration s] per note. */
const TONES: Record<Cue, { wave: OscillatorType; gain: number; notes: Array<[number, number, number]>; glide?: number }> = {
  select: { wave: "sine", gain: 0.05, notes: [[880, 0, 0.05]] },
  correct: { wave: "triangle", gain: 0.09, notes: [[784, 0, 0.11], [1175, 0.09, 0.2]] },
  wrong: { wave: "triangle", gain: 0.08, notes: [[247, 0, 0.22]], glide: 196 },
  complete: { wave: "triangle", gain: 0.08, notes: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.32]] },
};
const VIBRATION: Record<Cue, number | number[]> = { select: 8, correct: 18, wrong: [30, 50, 30], complete: [20, 40, 20, 40, 60] };

let audio: AudioContext | null = null;

function play(kind: Cue) {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return;
  audio ??= new Context();
  if (audio.state === "suspended") void audio.resume();
  const tone = TONES[kind];
  const now = audio.currentTime;
  for (const [frequency, start, duration] of tone.notes) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(frequency, now + start);
    if (tone.glide) oscillator.frequency.exponentialRampToValueAtTime(tone.glide, now + start + duration);
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(tone.gain, now + start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
    oscillator.connect(gain).connect(audio.destination);
    oscillator.start(now + start);
    oscillator.stop(now + start + duration + 0.02);
  }
}

/** Plays a cue the learner's settings allow. Call only from a user action or its direct result. */
export function cue(kind: Cue) {
  if (typeof window === "undefined") return;
  const prefs = read();
  try {
    if (prefs.sound) play(kind);
    if (prefs.haptics && typeof navigator.vibrate === "function") navigator.vibrate(VIBRATION[kind]);
  } catch { /* audio or vibration unavailable: the visual feedback still shows */ }
}
