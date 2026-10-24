"use client";

import "@/components/academy/lesson/academy-lesson.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { Globe2, Music, Volume1, Volume2, VolumeX, Waves } from "lucide-react";
import { audioState, cue, primeAudio, setFeedbackPrefs, useFeedbackPrefs, type FeedbackPrefs } from "./academy-sound";
import { syncMusic } from "./academy-music";
import { usePresence } from "./academy-feel";

/**
 * The Academy's audio and comfort settings, from one speaker button: master, music and effects
 * volumes (each 0–100%), music and effects switches, mute, vibration and animations — plus, on the
 * map, changing the map world. Everything applies at once and is kept on this device.
 */
export function AcademyAudioSettings({ tone = "light", onChangeWorld }: { tone?: "light" | "dark"; onChangeWorld?: () => void }) {
  const prefs = useFeedbackPrefs();
  const [open, setOpen] = useState(false);
  const panel = usePresence(open ? true : null, 160);
  const silent = prefs.muted || prefs.master === 0;
  const Icon = silent ? VolumeX : prefs.master < 0.45 ? Volume1 : Volume2;
  const close = useCallback(() => { cue("close"); setOpen(false); }, []);

  return (
    <div className="relative">
      <button
        type="button"
        className={tone === "dark" ? "grid h-9 w-9 place-items-center rounded-full border border-white/20 bg-white/10 hover:bg-white/20" : "ax-toggle"}
        style={tone === "dark" ? { color: "#fff" } : undefined}
        aria-label={`Audio and settings${silent ? " (muted)" : ""}`}
        aria-expanded={open}
        data-muted={silent ? "true" : undefined}
        onClick={() => { primeAudio(); if (open) close(); else { cue("open"); setOpen(true); } }}
      >
        <span key={silent ? "off" : "on"} className="ax-pop inline-flex"><Icon className={tone === "dark" ? "h-4 w-4" : "h-5 w-5"} aria-hidden /></span>
      </button>
      {panel.shown ? <Panel prefs={prefs} closing={panel.closing} onClose={close} onChangeWorld={onChangeWorld ? () => { setOpen(false); onChangeWorld(); } : undefined} /> : null}
    </div>
  );
}

function Panel({ prefs, closing, onClose, onChangeWorld }: { prefs: FeedbackPrefs; closing: boolean; onClose: () => void; onChangeWorld?: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  // The browser may still be holding audio back (it needs a tap): show it, and check again while open.
  const [status, setStatus] = useState(audioState);
  useEffect(() => {
    first.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const timer = window.setInterval(() => setStatus(audioState()), 500);
    return () => { window.removeEventListener("keydown", onKey); window.clearInterval(timer); };
  }, [onClose]);
  const set = (next: Partial<FeedbackPrefs>) => { primeAudio(); setFeedbackPrefs(next); syncMusic(); };
  const silent = prefs.muted || prefs.master === 0;

  return (
    <>
      <button type="button" tabIndex={-1} aria-label="Close settings" className="fixed inset-0 z-40 cursor-default" onClick={onClose} />
      <div role="dialog" aria-label="Audio and settings" className="ax-menu ax-audio" data-closing={closing ? "true" : undefined}>
        <div className="flex items-center gap-2 px-2 pb-1 pt-1">
          <p className="flex-1 text-[14px] font-extrabold">Audio &amp; settings</p>
          <span className="ax-status" data-state={silent ? "muted" : status}>{silent ? "Muted" : status === "running" ? "Audio on" : status === "blocked" ? "Tap to start audio" : "No audio on this browser"}</span>
        </div>
        <button ref={first} type="button" className="ax-menu-row" aria-pressed={prefs.muted} onClick={() => set({ muted: !prefs.muted })}>
          {prefs.muted ? <VolumeX className="h-5 w-5 shrink-0" aria-hidden /> : <Volume2 className="h-5 w-5 shrink-0" aria-hidden />}
          <span className="min-w-0 flex-1 text-left text-[14px] font-bold">{prefs.muted ? "Unmute" : "Mute all"}</span>
        </button>
        <Slider label="Master volume" value={prefs.master} disabled={prefs.muted} onChange={(master) => set({ master })} />
        <SwitchRow icon={<Music className="h-4 w-4" aria-hidden />} label="Music" checked={prefs.music} onToggle={() => set({ music: !prefs.music })} />
        <Slider label="Music volume" value={prefs.musicVolume} disabled={!prefs.music || prefs.muted} onChange={(musicVolume) => set({ musicVolume })} />
        <SwitchRow icon={<Waves className="h-4 w-4" aria-hidden />} label="Sound effects" checked={prefs.sound} onToggle={() => set({ sound: !prefs.sound })} />
        <Slider label="Effects volume" value={prefs.sfxVolume} disabled={!prefs.sound || prefs.muted} onChange={(sfxVolume) => set({ sfxVolume })} onCommit={() => cue("correct")} />
        <div className="my-1 h-px bg-border-soft" aria-hidden />
        <SwitchRow label="Vibration" note="Phones that support it" checked={prefs.haptics} onToggle={() => set({ haptics: !prefs.haptics })} />
        <SwitchRow label="Animations" note="Tiko, transitions and sparkles" checked={prefs.motion} onToggle={() => set({ motion: !prefs.motion })} />
        {onChangeWorld ? (
          <button type="button" className="ax-menu-row" onClick={onChangeWorld}>
            <Globe2 className="h-5 w-5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 text-left"><span className="block text-[14px] font-bold">Change map world</span><span className="block text-[12px] text-muted">Your progress stays the same</span></span>
          </button>
        ) : null}
      </div>
    </>
  );
}

function SwitchRow({ icon, label, note, checked, onToggle }: { icon?: React.ReactNode; label: string; note?: string; checked: boolean; onToggle: () => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="ax-menu-row" onClick={onToggle}>
      {icon ? <span className="grid h-5 w-5 shrink-0 place-items-center">{icon}</span> : null}
      <span className="min-w-0 flex-1 text-left"><span className="block text-[14px] font-bold">{label}</span>{note ? <span className="block text-[12px] text-muted">{note}</span> : null}</span>
      <span className="ax-switch" data-on={checked ? "true" : "false"} aria-hidden><i /></span>
    </button>
  );
}

function Slider({ label, value, disabled, onChange, onCommit }: { label: string; value: number; disabled?: boolean; onChange: (value: number) => void; onCommit?: () => void }) {
  const percent = Math.round(value * 100);
  return (
    <label className="ax-slider-row" data-disabled={disabled ? "true" : undefined}>
      <span className="flex items-center justify-between text-[12px] font-bold text-text-2"><span>{label}</span><span className="tabular-nums">{percent}%</span></span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        disabled={disabled}
        aria-label={label}
        className="ax-range"
        style={{ ["--val" as string]: `${percent}%` }}
        onChange={(event) => onChange(Number(event.target.value) / 100)}
        onPointerUp={onCommit}
        onKeyUp={(event) => { if (event.key.startsWith("Arrow")) onCommit?.(); }}
      />
    </label>
  );
}
