"use client";

import { useSyncExternalStore } from "react";

/**
 * Academy sound and haptics. Every effect is synthesised with Web Audio (no files to download): each
 * note layers a main voice with a softer octave voice, through one master chain (a gentle compressor
 * and a short echo) so the set sounds like one instrument. Browsers only allow audio after a user
 * gesture, so the first tap in the Academy unlocks it (`primeAudio`). Sound, music, vibration and
 * animation are separate switches, kept on this device.
 */

/** Volumes are 0–1. `muted` silences everything at once without losing the levels. */
export type FeedbackPrefs = { sound: boolean; music: boolean; haptics: boolean; motion: boolean; muted: boolean; master: number; musicVolume: number; sfxVolume: number };
export type Cue =
  | "tap" | "select" | "check" | "correct" | "wrong" | "dialogue" | "hint" | "combo" | "unlock" | "complete"
  | "open" | "close" | "page" | "reveal" | "start" | "locked";

// v2: sound and music now start on (the first Academy version started silent, which read as "no sound").
const KEY = "td-academy-feedback-v2";
const DEFAULT: FeedbackPrefs = { sound: true, music: true, haptics: true, motion: true, muted: false, master: 0.85, musicVolume: 0.6, sfxVolume: 0.9 };
const clamp = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback);
const listeners = new Set<() => void>();
let cache: FeedbackPrefs | null = null;

function read(): FeedbackPrefs {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<FeedbackPrefs>) : {};
    cache = {
      ...DEFAULT,
      ...parsed,
      master: clamp(parsed.master, DEFAULT.master),
      musicVolume: clamp(parsed.musicVolume, DEFAULT.musicVolume),
      sfxVolume: clamp(parsed.sfxVolume, DEFAULT.sfxVolume),
    };
  } catch {
    cache = DEFAULT;
  }
  return cache;
}

export function feedbackPrefs() {
  return read();
}

export function setFeedbackPrefs(next: Partial<FeedbackPrefs>) {
  cache = { ...read(), ...next };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage unavailable: kept for this visit */ }
  listeners.forEach((listener) => listener());
  applyVolumes();
  if (next.sound || next.muted === false) cue("select");
}

export function useFeedbackPrefs() {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    read,
    () => DEFAULT,
  );
}

/* ---------------- the audio graph ---------------- */

type Graph = { context: AudioContext; master: GainNode; sfx: GainNode; music: GainNode; echo: GainNode; musicLevel: GainNode };
let graph: Graph | null = null;

/** The shared audio graph (created on first use, after a gesture). Null where Web Audio is missing. */
export function audioGraph(): Graph | null {
  if (typeof window === "undefined") return null;
  if (graph) return graph;
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context) return null;
  const context = new Context();
  const compressor = context.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 3;
  // Master volume (and mute) sit after the compressor, so the levels are what the learner set.
  const master = context.createGain();
  master.connect(context.destination);
  compressor.connect(master);
  // A short, quiet echo gives the effects a little space.
  const delay = context.createDelay(1);
  delay.delayTime.value = 0.16;
  const feedback = context.createGain();
  feedback.gain.value = 0.22;
  const echo = context.createGain();
  echo.gain.value = 0.18;
  echo.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(compressor);
  const sfx = context.createGain();
  sfx.connect(compressor);
  sfx.connect(echo);
  // The music bus: `music` is the learner's music volume, `musicLevel` the player's fades (0–1).
  const music = context.createGain();
  const musicLevel = context.createGain();
  musicLevel.gain.value = 0;
  musicLevel.connect(music);
  music.connect(compressor);
  graph = { context, master, sfx, music, echo, musicLevel };
  applyVolumes();
  return graph;
}

/** Sets the gains from the learner's settings (smoothly, so a slider never clicks). */
function applyVolumes() {
  if (!graph) return;
  const prefs = read();
  const at = graph.context.currentTime;
  const set = (node: GainNode, value: number) => { node.gain.cancelScheduledValues(at); node.gain.setTargetAtTime(value, at, 0.04); };
  set(graph.master, prefs.muted ? 0 : prefs.master);
  set(graph.sfx, prefs.sound ? prefs.sfxVolume * 1.1 : 0);
  set(graph.music, prefs.music ? prefs.musicVolume : 0);
}

/** Whether the browser has let audio start (it needs a tap first). */
export function audioState(): "running" | "blocked" | "unsupported" {
  if (typeof window === "undefined") return "unsupported";
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  if (!Context) return "unsupported";
  return graph?.context.state === "running" ? "running" : "blocked";
}

/** Unlocks audio from a user gesture (browsers keep it suspended until then). */
export function primeAudio() {
  const current = audioGraph();
  if (current && current.context.state === "suspended") void current.context.resume();
}

type Note = [frequency: number, start: number, duration: number];
type Tone = { wave: OscillatorType; gain: number; notes: Note[]; glide?: number; layer?: number; noise?: boolean };

const C5 = 523.25, D5 = 587.33, E5 = 659.25, G5 = 783.99, A5 = 880, B5 = 987.77, C6 = 1046.5, D6 = 1174.66, E6 = 1318.51, G6 = 1567.98;
const TONES: Record<Cue, Tone> = {
  tap: { wave: "sine", gain: 0.12, notes: [[1200, 0, 0.035]], layer: 0 },
  select: { wave: "triangle", gain: 0.2, notes: [[A5, 0, 0.07]], layer: 0.35 },
  check: { wave: "sine", gain: 0.16, notes: [[E5, 0, 0.05], [B5, 0.045, 0.07]] },
  correct: { wave: "triangle", gain: 0.26, notes: [[G5, 0, 0.12], [D6, 0.1, 0.16], [G6, 0.2, 0.32]], layer: 0.4 },
  wrong: { wave: "sine", gain: 0.24, notes: [[311, 0, 0.16], [233, 0.13, 0.3]], glide: 0.94, layer: 0.3 },
  dialogue: { wave: "sine", gain: 0.12, notes: [[C6, 0, 0.05], [E6, 0.05, 0.06], [G6, 0.1, 0.08]] },
  hint: { wave: "triangle", gain: 0.16, notes: [[A5, 0, 0.08], [D6, 0.07, 0.08], [A5 * 2, 0.14, 0.18]], layer: 0.3 },
  combo: { wave: "triangle", gain: 0.24, notes: [[G5, 0, 0.08], [B5, 0.07, 0.08], [D6, 0.14, 0.08], [G6, 0.21, 0.36]], layer: 0.45 },
  unlock: { wave: "sine", gain: 0.24, notes: [[D5, 0, 0.12], [A5, 0.1, 0.12], [D6, 0.2, 0.14], [A5 * 2, 0.32, 0.4]], layer: 0.5 },
  complete: { wave: "triangle", gain: 0.24, notes: [[C5, 0, 0.12], [E5, 0.11, 0.12], [G5, 0.22, 0.12], [C6, 0.33, 0.14], [E6, 0.46, 0.16], [G6, 0.6, 0.55]], layer: 0.45 },
  open: { wave: "sine", gain: 0.13, notes: [[420, 0, 0.13]], glide: 2.1, noise: true },
  close: { wave: "sine", gain: 0.11, notes: [[820, 0, 0.12]], glide: 0.5, noise: true },
  page: { wave: "sine", gain: 0.1, notes: [[560, 0, 0.1]], glide: 1.6, noise: true },
  reveal: { wave: "sine", gain: 0.11, notes: [[E5, 0, 0.09], [A5, 0.06, 0.1], [E6, 0.12, 0.18]], layer: 0.3 },
  start: { wave: "triangle", gain: 0.22, notes: [[G5 / 2, 0, 0.1], [C5, 0.08, 0.1], [E5, 0.16, 0.1], [G5, 0.24, 0.3]], layer: 0.4 },
  locked: { wave: "square", gain: 0.06, notes: [[196, 0, 0.09], [185, 0.1, 0.12]] },
};

// Only meaningful moments vibrate (taps, picks and panels are too small to buzz).
const VIBRATION: Partial<Record<Cue, number | number[]>> = { correct: 18, wrong: [30, 50, 30], combo: [16, 30, 16, 30, 24], unlock: [20, 40, 40], complete: [20, 40, 20, 40, 60], locked: 12 };

function voice(context: AudioContext, out: AudioNode, wave: OscillatorType, frequency: number, at: number, duration: number, peak: number, glide?: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(frequency, at);
  if (glide) oscillator.frequency.exponentialRampToValueAtTime(frequency * glide, at + duration);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  oscillator.connect(gain).connect(out);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.03);
}

/** A soft filtered-noise "air" layer for whooshes (panels opening and closing, pages turning). */
function air(context: AudioContext, out: AudioNode, at: number, duration: number, peak: number, rising: boolean) {
  const length = Math.ceil(context.sampleRate * duration);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1;
  const source = context.createBufferSource();
  source.buffer = buffer;
  const filter = context.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = 0.9;
  filter.frequency.setValueAtTime(rising ? 700 : 2600, at);
  filter.frequency.exponentialRampToValueAtTime(rising ? 2600 : 700, at + duration);
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + duration * 0.35);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  source.connect(filter).connect(gain).connect(out);
  source.start(at);
}

function play(kind: Cue) {
  const current = audioGraph();
  if (!current) return;
  const { context, sfx } = current;
  if (context.state === "suspended") void context.resume();
  // Test hook: an automated check can list the effects that played (absent for real users).
  (window as unknown as { __academySfx?: Cue[] }).__academySfx?.push(kind);
  const tone = TONES[kind];
  const now = context.currentTime + 0.005;
  for (const [frequency, start, duration] of tone.notes) {
    voice(context, sfx, tone.wave, frequency, now + start, duration, tone.gain, tone.glide);
    // A quieter voice an octave up makes the note shimmer.
    if (tone.layer) voice(context, sfx, "sine", frequency * 2, now + start, duration * 0.8, tone.gain * tone.layer, tone.glide);
  }
  if (tone.noise) air(context, sfx, now, tone.notes[0][2] + 0.06, tone.gain * 0.5, kind !== "close");
}

const lastPlayed = new Map<Cue, number>();
let lastAny = -Infinity;

/** Plays a cue the learner's settings allow. Call only from a user action or its direct result. */
export function cue(kind: Cue) {
  if (typeof window === "undefined") return;
  const now = performance.now();
  // One event plays once, even if a handler runs twice in quick succession (e.g. development double calls).
  if (now - (lastPlayed.get(kind) ?? -Infinity) < 90) return;
  // A generic tap never doubles a control's own sound.
  if (kind === "tap" && now - lastAny < 120) return;
  lastPlayed.set(kind, now);
  lastAny = now;
  const prefs = read();
  try {
    if (prefs.sound && !prefs.muted && prefs.master > 0 && prefs.sfxVolume > 0) play(kind);
    const pattern = VIBRATION[kind];
    if (prefs.haptics && pattern && typeof navigator.vibrate === "function") navigator.vibrate(pattern);
  } catch { /* audio or vibration unavailable: the visual feedback still shows */ }
}
