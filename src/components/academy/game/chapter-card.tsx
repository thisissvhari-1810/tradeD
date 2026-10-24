import { Check, Lock } from "lucide-react";
import type { JourneyChapter } from "@/lib/academy/world";
import { THEME } from "./world-art";
import type { WorldDef } from "./worlds/config";

/** A chapter's sign: number, name, what it covers and real progress from the server's records. */
export function ChapterCard({ chapter, world, previous, style, fresh }: { chapter: JourneyChapter; world: WorldDef; previous: string | null; style: React.CSSProperties; fresh: boolean }) {
  const theme = world.region(chapter.index);
  const name = world.chapters[chapter.index] ?? chapter.def.name;
  const percent = chapter.total ? Math.round((chapter.done / chapter.total) * 100) : 0;
  return (
    <header className="mq-chapter-card" data-fresh={fresh ? "true" : undefined} style={{ ...style, ["--accent" as string]: theme.accent }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="mq-chip" style={{ background: "rgba(255,255,255,.12)", color: theme.accent }}>Chapter {chapter.unit.number}</span>
        {chapter.status === "complete" ? <span className="mq-chip" style={{ background: "#ffc83d", color: "#3a2600" }}><Check className="h-3 w-3" strokeWidth={3.5} aria-hidden />Completed</span>
          : chapter.status === "active" ? <span className="mq-chip" style={{ background: "rgba(63,224,141,.18)", color: "#7dffc0" }}>In progress</span>
            : <span className="mq-chip" style={{ background: "rgba(255,255,255,.1)", color: "rgba(255,255,255,.75)" }}><Lock className="h-3 w-3" aria-hidden />Up next</span>}
      </div>
      <h2 className="mt-2 text-[clamp(1.15rem,2vw,1.45rem)] font-black leading-tight tracking-tight">{name}</h2>
      <p className="mt-0.5 text-[13px] leading-snug text-white/75">{chapter.def.subtitle}</p>
      <div className="mt-3 flex items-center gap-2.5">
        <span className="mq-meter flex-1" role="progressbar" aria-label={`${name} progress`} aria-valuemin={0} aria-valuemax={chapter.total} aria-valuenow={chapter.done}><span style={{ width: `${percent}%` }} /></span>
        <span className="text-[12px] font-bold tabular-nums text-white/80">{chapter.done}/{chapter.total} lessons</span>
      </div>
      {chapter.status === "locked" && previous ? <p className="mt-2 text-[12px] font-semibold text-white/65">Opens when you finish {previous}.</p> : null}
    </header>
  );
}

/** The chapters not reached yet, waiting in the mist (tapping one asks Tiko what opens it). */
export function RoadAhead({ chapters, world, current, style, onHint }: { chapters: JourneyChapter[]; world: WorldDef; current: string; style: React.CSSProperties; onHint: (chapter: JourneyChapter) => void }) {
  return (
    <section className="absolute z-[3]" style={style} aria-label="Chapters ahead">
      <h2 className="text-center text-[clamp(1.05rem,1.8vw,1.3rem)] font-black tracking-tight text-white drop-shadow-[0_2px_0_rgba(0,0,0,.35)]">The road ahead</h2>
      <p className="mt-1 text-center text-[13px] font-semibold text-white/75">Finish {current} to reach the next region.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-3">
        {chapters.map((chapter) => {
          const theme = world.region(chapter.index);
          const Glyph = THEME[chapter.def.theme].glyph;
          const name = world.chapters[chapter.index] ?? chapter.def.name;
          return (
            <button key={chapter.unit.id} type="button" className="mq-fog-card" onClick={() => onHint(chapter)} aria-label={`Chapter ${chapter.unit.number}: ${name}. ${chapter.total} lessons. Locked.`}>
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl" style={{ background: `linear-gradient(165deg, ${theme.face[0]}, ${theme.face[1]})`, filter: "saturate(.45) brightness(.8)", boxShadow: `0 3px 0 ${theme.rim}` }} aria-hidden>
                <Glyph className="h-6 w-6 text-white" strokeWidth={2.4} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-extrabold uppercase tracking-[0.12em] text-white/55">Chapter {chapter.unit.number}</span>
                <span className="block truncate text-[15px] font-extrabold">{name}</span>
                <span className="block text-[12px] text-white/65">{chapter.total} lessons</span>
              </span>
              <Lock className="h-4 w-4 shrink-0 text-white/60" aria-hidden />
            </button>
          );
        })}
      </div>
    </section>
  );
}
