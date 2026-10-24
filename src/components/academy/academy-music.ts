"use client";

import { audioGraph, feedbackPrefs } from "./academy-sound";

/**
 * The Academy's background music: an upbeat, original electronic loop generated with Web Audio (no
 * files to download) — kick, clap and hi-hats from filtered noise, a driving bass, off-beat chord stabs
 * and a plucked lead, over Am – F – C – G. The arrangement changes every few bars (lead patterns, fills
 * and a short breakdown) so it does not wear thin. It fades in after the first tap, keeps playing
 * between the map and lessons (a little quieter in lessons), and fades out when the learner leaves.
 */

const BPM = 112;
const STEP = 60 / BPM / 4; // sixteenth notes
const BAR = 16;

// Am – F – C – G, one bar each. Frequencies in Hz.
const CHORDS: Array<{ root: number; stab: number[]; lead: number[] }> = [
  { root: 55, stab: [220, 261.63, 329.63], lead: [440, 523.25, 659.25, 783.99, 880] },
  { root: 43.65, stab: [174.61, 220, 261.63], lead: [349.23, 440, 523.25, 659.25, 698.46] },
  { root: 65.41, stab: [261.63, 329.63, 392], lead: [523.25, 659.25, 783.99, 880, 1046.5] },
  { root: 49, stab: [196, 246.94, 293.66], lead: [392, 493.88, 587.33, 783.99, 987.77] },
];
// Lead patterns (indexes into the chord's lead notes; -1 rests), swapped every four bars.
const LEADS = [
  [0, -1, 2, -1, 1, -1, 3, -1, 2, -1, 4, -1, 3, -1, 1, -1],
  [0, 2, 4, -1, 3, -1, 2, -1, 0, 2, 4, 3, -1, 2, -1, 1],
  [4, -1, 3, -1, 2, 1, -1, 2, 4, -1, 3, -1, 2, -1, 0, -1],
];
const BASS = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0];

let timer: number | null = null;
let nextTime = 0;
let step = 0;
let users = 0;
let stopTimer: number | null = null;
let playing = false;
let level = 1;
let noise: AudioBuffer | null = null;

function noiseBuffer(context: AudioContext) {
  if (noise && noise.sampleRate === context.sampleRate) return noise;
  noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = noise.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
  return noise;
}

function envelope(context: AudioContext, at: number, peak: number, attack: number, decay: number) {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return gain;
}

function tone(context: AudioContext, out: AudioNode, wave: OscillatorType, frequency: number, at: number, peak: number, attack: number, decay: number, cutoff?: number, detune = 0) {
  const oscillator = context.createOscillator();
  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(frequency, at);
  oscillator.detune.value = detune;
  const gain = envelope(context, at, peak, attack, decay);
  oscillator.connect(gain);
  if (cutoff) {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    gain.connect(filter).connect(out);
  } else gain.connect(out);
  oscillator.start(at);
  oscillator.stop(at + attack + decay + 0.05);
}

function kick(context: AudioContext, out: AudioNode, at: number) {
  const oscillator = context.createOscillator();
  oscillator.frequency.setValueAtTime(140, at);
  oscillator.frequency.exponentialRampToValueAtTime(42, at + 0.14);
  const gain = envelope(context, at, 0.55, 0.004, 0.24);
  oscillator.connect(gain).connect(out);
  oscillator.start(at);
  oscillator.stop(at + 0.3);
}

function hiss(context: AudioContext, out: AudioNode, at: number, peak: number, decay: number, type: BiquadFilterType, frequency: number) {
  const source = context.createBufferSource();
  source.buffer = noiseBuffer(context);
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  const gain = envelope(context, at, peak, 0.002, decay);
  source.connect(filter).connect(gain).connect(out);
  source.start(at, Math.random() * 0.5);
  source.stop(at + decay + 0.05);
}

/** Schedules the notes of the next short window (a standard Web Audio look-ahead scheduler). */
function schedule() {
  const current = audioGraph();
  if (!current) return;
  const { context, musicLevel: out, echo } = current;
  while (nextTime < context.currentTime + 0.3) {
    const bar = Math.floor(step / BAR);
    const sixteenth = step % BAR;
    const chord = CHORDS[bar % CHORDS.length];
    const phrase = bar % 16;
    const breakdown = phrase === 14 || phrase === 15; // two quieter bars every sixteen
    const fill = bar % 4 === 3 && sixteenth >= 12;
    // Drums
    if (!breakdown && sixteenth % 4 === 0) kick(context, out, nextTime);
    if (!breakdown && (sixteenth === 4 || sixteenth === 12)) hiss(context, out, nextTime, 0.22, 0.12, "bandpass", 1800);
    if (fill && sixteenth % 2 === 1) hiss(context, out, nextTime, 0.12, 0.06, "bandpass", 2400);
    if (sixteenth % 2 === 1 || (breakdown && sixteenth % 4 === 2)) hiss(context, out, nextTime, sixteenth % 4 === 3 ? 0.07 : 0.045, 0.035, "highpass", 8000);
    // Bass
    if (!breakdown && BASS[sixteenth]) tone(context, out, "sawtooth", chord.root * (sixteenth === 14 ? 2 : 1), nextTime, 0.16, 0.006, STEP * 1.6, 520);
    if (breakdown && sixteenth === 0) tone(context, out, "triangle", chord.root * 2, nextTime, 0.12, 0.02, STEP * 14, 700);
    // Off-beat chord stabs
    if (sixteenth % 4 === 2) for (const frequency of chord.stab) tone(context, out, "triangle", frequency, nextTime, breakdown ? 0.03 : 0.045, 0.004, STEP * 1.4, 2400, 6);
    // Lead (rests in the first bars of each phrase so it can build)
    const pattern = LEADS[Math.floor(bar / 4) % LEADS.length];
    const pick = pattern[sixteenth];
    if (phrase >= 2 && pick >= 0) {
      const frequency = chord.lead[pick];
      tone(context, out, "square", frequency, nextTime, 0.032, 0.004, STEP * 1.8, 3200);
      if (sixteenth % 4 === 0) tone(context, echo, "sine", frequency * 2, nextTime, 0.03, 0.004, STEP * 2);
    }
    nextTime += STEP;
    step += 1;
  }
}

function fade(to: number, seconds: number) {
  const current = audioGraph();
  if (!current) return;
  const { context, musicLevel } = current;
  musicLevel.gain.cancelScheduledValues(context.currentTime);
  musicLevel.gain.setValueAtTime(Math.max(0.0001, musicLevel.gain.value), context.currentTime);
  musicLevel.gain.exponentialRampToValueAtTime(Math.max(0.0001, to), context.currentTime + seconds);
}

function start() {
  const current = audioGraph();
  if (!current || document.hidden) return;
  if (current.context.state === "suspended") void current.context.resume();
  if (playing) return;
  playing = true;
  nextTime = current.context.currentTime + 0.12;
  schedule();
  timer = window.setInterval(schedule, 100);
  fade(level, 1.8);
}

function stop(seconds = 0.8) {
  if (!playing) return;
  playing = false;
  // No new notes from now on; the fade covers the few already scheduled (a third of a second ahead).
  if (timer != null) window.clearInterval(timer);
  timer = null;
  fade(0.0001, seconds);
}

/** Starts or stops the music to match the learner's settings (call from a tap, so audio may start). */
export function syncMusic() {
  const prefs = feedbackPrefs();
  if (users > 0 && prefs.music && !prefs.muted && prefs.musicVolume > 0) start();
  else stop();
}

/** Lessons play the music a little quieter than the map (fades smoothly between the two). */
export function setMusicLevel(next: number) {
  level = next;
  if (playing) fade(level, 0.9);
}

const onVisibility = () => { if (document.hidden) stop(0.3); else syncMusic(); };

/**
 * An Academy screen is open (the map, a lesson or a mission). Music keeps playing while moving
 * between them; leaving the Academy fades it out. Returns the matching release.
 */
export function holdMusic() {
  users += 1;
  if (stopTimer != null) { window.clearTimeout(stopTimer); stopTimer = null; }
  if (users === 1) document.addEventListener("visibilitychange", onVisibility);
  return () => {
    users -= 1;
    if (users > 0) return;
    // A short grace period: going from the map to a lesson is a remount, not leaving.
    stopTimer = window.setTimeout(() => {
      stopTimer = null;
      if (users === 0) {
        stop(0.6);
        document.removeEventListener("visibilitychange", onVisibility);
      }
    }, 600);
  };
}
