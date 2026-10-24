"use client";

import { useSyncExternalStore } from "react";

/**
 * Academy sound and haptic cues. Sound starts off and only plays after the learner switches it on
 * (itself a tap, so the browser allows audio); vibration is used only where the device supports it.
 * The tones are synthesised with Web Audio, so there are no sound files to download. Preferences are
 * kept on this device.
 */

/** Sound, vibration and animation are switched independently (less sensory input when wanted). */
export type FeedbackPrefs = { sound: boolean; haptics: boolean; motion: boolean };
export type Cue = "select" | "check" | "correct" | "wrong" | "dialogue" | "hint" | "combo" | "unlock" | "complete";

const KEY = "td-academy-feedback";
const DEFAULT: FeedbackPrefs = { sound: false, haptics: true, motion: true };
const listeners = new Set<() => void>();
let cache: FeedbackPrefs | null = null;

function read(): FeedbackPrefs {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<FeedbackPrefs>) : {};
    cache = { sound: parsed.sound === true, haptics: parsed.haptics !== false, motion: parsed.motion !== false };
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
  check: { wave: "sine", gain: 0.04, notes: [[660, 0, 0.04], [990, 0.035, 0.05]] },
  correct: { wave: "triangle", gain: 0.09, notes: [[784, 0, 0.11], [1175, 0.09, 0.2]] },
  wrong: { wave: "triangle", gain: 0.08, notes: [[247, 0, 0.22]], glide: 196 },
  dialogue: { wave: "sine", gain: 0.035, notes: [[1046, 0, 0.05], [1318, 0.05, 0.07]] },
  hint: { wave: "sine", gain: 0.05, notes: [[880, 0, 0.08], [1175, 0.07, 0.08], [1568, 0.14, 0.14]] },
  combo: { wave: "triangle", gain: 0.08, notes: [[784, 0, 0.09], [988, 0.08, 0.09], [1319, 0.16, 0.24]] },
  unlock: { wave: "sine", gain: 0.07, notes: [[587, 0, 0.12], [880, 0.1, 0.12], [1175, 0.2, 0.3]] },
  complete: { wave: "triangle", gain: 0.08, notes: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.12], [1047, 0.3, 0.32]] },
};
// Only meaningful moments vibrate (a pick and a press are too small to buzz).
const VIBRATION: Record<Cue, number | number[] | null> = { select: null, check: null, dialogue: null, hint: null, correct: 18, wrong: [30, 50, 30], combo: [16, 30, 16, 30, 24], unlock: [20, 40, 40], complete: [20, 40, 20, 40, 60] };
const lastPlayed = new Map<Cue, number>();

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
  // One event plays once, even if a handler runs twice in quick succession (e.g. development double calls).
  const now = performance.now();
  if (now - (lastPlayed.get(kind) ?? -Infinity) < 90) return;
  lastPlayed.set(kind, now);
  const prefs = read();
  try {
    if (prefs.sound) play(kind);
    const pattern = VIBRATION[kind];
    if (prefs.haptics && pattern && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch { /* audio or vibration unavailable: the visual feedback still shows */ }
}
