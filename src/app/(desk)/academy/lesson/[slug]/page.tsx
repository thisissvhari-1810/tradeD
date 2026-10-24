"use client";

import { use } from "react";
import { LessonPlayer } from "@/components/academy/lesson-player";

export default function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  return <LessonPlayer slug={slug} />;
}
