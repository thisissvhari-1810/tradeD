"use client";

import { audioGraph, feedbackPrefs } from "./academy-sound";

/**
 * The Academy's background music: a calm, generated loop (soft chord pads, a plucked arpeggio and a
 * light bass) on the shared audio graph, so no music files are downloaded. It fades in after the
 * first tap in the Academy, keeps playing between the map and lessons, fades out when the learner
 * leaves the Academy or switches music off, and pauses while the tab is hidden.
 */

const BPM = 88;
const STEP = 60 / BPM / 2; // eighth notes
const VOLUME = 0.42; // relative to the effects (the music bus feeds the same compressor)

// Four chords, two bars each: Cmaj7 – Am7 – Fmaj7 – G6 (a warm, unresolved loop).
const CHORDS: Array<{ bass: number; pad: number[]; arp: number[] }> = [
  { bass: 65.41, pad: [261.63, 329.63, 392, 493.88], arp: [523.25, 659.25, 783.99, 987.77, 783.99, 659.25, 523.25, 659.25] },
  { bass: 55, pad: [220, 261.63, 329.63, 392], arp: [440, 523.25, 659.25, 783.99, 659.25, 523.25, 440, 523.25] },
  { bass: 43.65, pad: [174.61, 220, 261.63, 329.63], arp: [349.23, 440, 523.25, 659.25, 523.25, 440, 349.23, 440] },
  { bass: 49, pad: [196, 246.94, 293.66, 329.63], arp: [392, 493.88, 587.33, 659.25, 587.33, 493.88, 392, 587.33] },
];
const STEPS_PER_CHORD = 16;

let timer: number | null = null;
let nextTime = 0;
let step = 0;
let users = 0;
let stopTimer: number | null = null;
let playing = false;

function note(context: AudioContext, out: AudioNode, wave: OscillatorType, frequency: number, at: number, duration: number, peak: number, attack: number, cutoff?: number) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = wave;
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(peak, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  let last: AudioNode = gain;
  if (cutoff) {
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    gain.connect(filter);
    last = filter;
  }
  oscillator.connect(gain);
  last.connect(out);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.05);
}

/** Schedules the notes falling in the next short window (a standard Web Audio look-ahead scheduler). */
function schedule() {
  const current = audioGraph();
  if (!current) return;
  const { context, music, echo } = current;
  while (nextTime < context.currentTime + 0.35) {
    const chord = CHORDS[Math.floor(step / STEPS_PER_CHORD) % CHORDS.length];
    const inChord = step % STEPS_PER_CHORD;
    if (inChord === 0) {
      // Pad: the chord, swelling slowly over two bars.
      for (const frequency of chord.pad) note(context, music, "triangle", frequency, nextTime, STEP * STEPS_PER_CHORD + 0.6, 0.035, 0.9, 1400);
      note(context, music, "sine", chord.bass, nextTime, STEP * 7, 0.12, 0.04);
    }
    if (inChord === 8) note(context, music, "sine", chord.bass * 1.5, nextTime, STEP * 6, 0.08, 0.04);
    // Arpeggio: a soft pluck on most eighths, with a little echo.
    if (inChord % 2 === 0 || inChord % 4 === 3) {
      const pitch = chord.arp[inChord % chord.arp.length];
      note(context, music, "sine", pitch, nextTime, STEP * 1.6, inChord % 4 === 0 ? 0.05 : 0.032, 0.006, 2600);
      if (inChord % 8 === 0) note(context, echo, "sine", pitch * 2, nextTime, STEP * 1.2, 0.02, 0.006);
    }
    nextTime += STEP;
    step += 1;
  }
}

function fade(to: number, seconds: number) {
  const current = audioGraph();
  if (!current) return;
  const { context, music } = current;
  music.gain.cancelScheduledValues(context.currentTime);
  music.gain.setValueAtTime(Math.max(0.0001, music.gain.value), context.currentTime);
  music.gain.exponentialRampToValueAtTime(Math.max(0.0001, to), context.currentTime + seconds);
}

function start() {
  const current = audioGraph();
  if (!current || playing || document.hidden) return;
  if (current.context.state === "suspended") void current.context.resume();
  playing = true;
  nextTime = current.context.currentTime + 0.1;
  schedule();
  timer = window.setInterval(schedule, 120);
  fade(VOLUME, 2.4);
}

function stop(seconds = 0.8) {
  if (!playing) return;
  playing = false;
  fade(0.0001, seconds);
  const running = timer;
  timer = null;
  window.setTimeout(() => { if (running != null) window.clearInterval(running); }, seconds * 1000);
}

/** Starts or stops the music to match the learner's switch (call from a tap, so audio may start). */
export function syncMusic() {
  if (users > 0 && feedbackPrefs().music && feedbackPrefs().sound) start();
  else stop();
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
