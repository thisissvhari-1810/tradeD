"use client";

import { use } from "react";
import { LessonPlayer } from "@/components/academy/lesson-player";
import { MissionPlayer } from "@/components/academy/game/mission-player";
import { missionFor } from "@/lib/academy/missions";

/** A story mission plays with Tiko; any other lesson uses the standard lesson player. */
export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const mission = missionFor(slug);
  return mission ? <MissionPlayer mission={mission} /> : <LessonPlayer slug={slug} />;
}
