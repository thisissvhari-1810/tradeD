import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { UNITS } from "@/lib/academy/content";
import { BADGES, DAILY_GOAL_XP, PASS_PERCENT, XP_RULES, answerText, earnedBadges, grade, istDay, lessonScore, lessonStates, levelFor, publicQuestion, streakFrom, weekOf, type LessonState } from "@/lib/academy/rules";
import type { AnswerInput, Lesson, Unit } from "@/lib/academy/types";
import type { SessionUser } from "@/server/auth";

/**
 * TradeD Academy on the server: every grade, XP award, streak day and badge is decided here from
 * the stored records. The browser never sends correctness, XP or streak values.
 */

function findLesson(slug: string): { unit: Unit; lesson: Lesson } {
  for (const unit of UNITS) {
    const lesson = unit.lessons.find((item) => item.slug === slug);
    if (lesson) return { unit, lesson };
  }
  throw new AppError("Lesson not found.", 404);
}

/** Monday 00:00 IST of the current week, as a Date. */
function weekStart(now = new Date()) {
  const today = istDay(now);
  const date = new Date(`${today}T00:00:00+05:30`);
  const weekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  return new Date(date.getTime() - weekday * 86_400_000);
}

async function loadState(userId: string) {
  const today = istDay();
  const [progress, days, xp, xpWeek, xpToday, badges] = await Promise.all([
    prisma.academyProgress.findMany({ where: { userId } }),
    prisma.academyDay.findMany({ where: { userId }, select: { day: true } }),
    prisma.xpEvent.aggregate({ where: { userId }, _sum: { amount: true } }),
    prisma.xpEvent.aggregate({ where: { userId, createdAt: { gte: weekStart() } }, _sum: { amount: true } }),
    prisma.xpEvent.aggregate({ where: { userId, createdAt: { gte: new Date(`${today}T00:00:00+05:30`) } }, _sum: { amount: true } }),
    prisma.userBadge.findMany({ where: { userId, badge: { slug: { startsWith: "academy-" } } }, include: { badge: true }, orderBy: { awardedAt: "desc" } }),
  ]);
  const byLesson = new Map(progress.map((row) => [row.lessonSlug, { completed: row.completedAt != null, bestScore: row.bestScore, started: true }]));
  return {
    today,
    progress,
    states: lessonStates(UNITS, byLesson),
    days: days.map((row) => row.day),
    xp: { total: xp._sum.amount ?? 0, week: xpWeek._sum.amount ?? 0, today: xpToday._sum.amount ?? 0 },
    badges,
  };
}

function lessonCard(lesson: Lesson, state: LessonState, unit: Unit, score = 0) {
  return { slug: lesson.slug, title: lesson.title, summary: lesson.summary, minutes: lesson.minutes, questions: lesson.questions.length, state, unit: unit.number, score };
}

/** Everything the Academy home and learning path need, for the signed-in user. */
export async function academyOverview(user: SessionUser) {
  const state = await loadState(user.id);
  const streak = streakFrom(state.days, state.today);
  const scores = new Map(state.progress.map((row) => [row.lessonSlug, row.bestScore]));
  const units = UNITS.map((unit) => {
    const lessons = unit.lessons.map((lesson) => lessonCard(lesson, state.states.get(lesson.slug) ?? "locked", unit, scores.get(lesson.slug) ?? 0));
    const done = lessons.filter((lesson) => lesson.state === "completed" || lesson.state === "mastered").length;
    return { id: unit.id, number: unit.number, title: unit.title, description: unit.description, done, total: lessons.length, lessons };
  });
  const next = units.flatMap((unit) => unit.lessons).find((lesson) => lesson.state === "in-progress" || lesson.state === "available") ?? null;
  const held = new Map(state.badges.map((row) => [row.badge.slug, row.awardedAt.toISOString()]));
  return {
    name: user.name.split(" ")[0] || user.name,
    level: { ...levelFor(state.xp.total), xp: state.xp.total },
    xp: { ...state.xp, dailyGoal: DAILY_GOAL_XP },
    streak: { ...streak, week: weekOf(state.days, state.today) },
    next,
    units,
    completed: units.reduce((sum, unit) => sum + unit.done, 0),
    total: units.reduce((sum, unit) => sum + unit.total, 0),
    badges: BADGES.map((badge) => ({ ...badge, earnedAt: held.get(badge.slug) ?? null })),
    rules: { passPercent: PASS_PERCENT, xp: XP_RULES },
  };
}

/** A lesson to study: cards and questions without answers. Locked lessons are refused. */
export async function academyLesson(user: SessionUser, slug: string) {
  const { unit, lesson } = findLesson(slug);
  const state = await loadState(user.id);
  const status = state.states.get(slug) ?? "locked";
  if (status === "locked") throw new AppError("Finish the lessons before this one to unlock it.", 403, "LESSON_LOCKED");
  await prisma.academyProgress.upsert({ where: { userId_lessonSlug: { userId: user.id, lessonSlug: slug } }, create: { userId: user.id, lessonSlug: slug }, update: {} });
  const correct = await prisma.academyAnswer.findMany({ where: { userId: user.id, lessonSlug: slug, correct: true }, select: { questionId: true }, distinct: ["questionId"] });
  const unitLessons = unit.lessons;
  const at = unitLessons.findIndex((item) => item.slug === slug);
  return {
    slug,
    title: lesson.title,
    summary: lesson.summary,
    minutes: lesson.minutes,
    topic: lesson.topic,
    unit: { number: unit.number, title: unit.title },
    position: { index: at + 1, of: unitLessons.length },
    state: status === "available" ? "in-progress" : status,
    cards: lesson.cards,
    questions: lesson.questions.map(publicQuestion),
    answeredCorrectly: correct.map((row) => row.questionId),
    passPercent: PASS_PERCENT,
  };
}

/** Grades one answer, records it, and pays XP for a question's first correct answer only. */
export async function academyAnswer(user: SessionUser, slug: string, questionId: string, input: AnswerInput) {
  const { lesson } = findLesson(slug);
  const question = lesson.questions.find((item) => item.id === questionId);
  if (!question) throw new AppError("Question not found.", 404);
  const state = await loadState(user.id);
  if ((state.states.get(slug) ?? "locked") === "locked") throw new AppError("This lesson is locked.", 403, "LESSON_LOCKED");
  const correct = grade(question, input);
  await prisma.academyAnswer.create({ data: { userId: user.id, lessonSlug: slug, questionId, correct } });
  let xp = 0;
  if (correct) {
    const paid = await prisma.xpEvent.createMany({ data: [{ userId: user.id, key: `answer:${questionId}`, amount: XP_RULES.correctAnswer, reason: `Correct answer · ${lesson.title}` }], skipDuplicates: true });
    xp = paid.count * XP_RULES.correctAnswer;
  }
  return {
    correct,
    explanation: question.explanation,
    mistake: correct ? null : question.mistake ?? null,
    answer: answerText(question),
    xp,
  };
}

/**
 * Completes a lesson when enough of its questions have been answered correctly (from stored
 * answers). First completion pays lesson and quiz XP once; the day counts towards the streak.
 */
export async function academyComplete(user: SessionUser, slug: string) {
  const { lesson } = findLesson(slug);
  const state = await loadState(user.id);
  if ((state.states.get(slug) ?? "locked") === "locked") throw new AppError("This lesson is locked.", 403, "LESSON_LOCKED");
  const rows = await prisma.academyAnswer.findMany({ where: { userId: user.id, lessonSlug: slug, correct: true }, select: { questionId: true } });
  const score = lessonScore(lesson, new Set(rows.map((row) => row.questionId)));
  if (score < PASS_PERCENT) throw new AppError(`Answer at least ${PASS_PERCENT}% of the questions correctly to complete this lesson (you have ${score}%).`, 400, "LESSON_NOT_PASSED");

  const result = await prisma.$transaction(async (tx) => {
    const before = await tx.academyProgress.findUnique({ where: { userId_lessonSlug: { userId: user.id, lessonSlug: slug } } });
    await tx.academyProgress.upsert({
      where: { userId_lessonSlug: { userId: user.id, lessonSlug: slug } },
      create: { userId: user.id, lessonSlug: slug, completedAt: new Date(), bestScore: score, completions: 1 },
      update: { completedAt: before?.completedAt ?? new Date(), bestScore: Math.max(before?.bestScore ?? 0, score), completions: { increment: 1 } },
    });
    // Each reward key exists once per user: a second completion (or a replayed request) pays nothing.
    const lessonPaid = await tx.xpEvent.createMany({ data: [{ userId: user.id, key: `lesson:${slug}`, amount: XP_RULES.lessonComplete, reason: `Lesson completed · ${lesson.title}` }], skipDuplicates: true });
    const quizPaid = await tx.xpEvent.createMany({ data: [{ userId: user.id, key: `quiz:${slug}`, amount: XP_RULES.quizComplete, reason: `Quiz completed · ${lesson.title}` }], skipDuplicates: true });
    await tx.academyDay.createMany({ data: [{ userId: user.id, day: istDay() }], skipDuplicates: true });
    return { firstTime: !before?.completedAt, xp: lessonPaid.count * XP_RULES.lessonComplete + quizPaid.count * XP_RULES.quizComplete };
  });

  const newBadges = await awardBadges(user.id, score === 100);
  const after = await loadState(user.id);
  return { score, firstTime: result.firstTime, xp: result.xp, xpTotal: after.xp.total, newBadges, streak: streakFrom(after.days, after.today), level: levelFor(after.xp.total) };
}

/** Awards any Academy badges the stored progress now earns; returns the newly awarded ones. */
async function awardBadges(userId: string, perfectNow: boolean) {
  const [progress, days, held] = await Promise.all([
    prisma.academyProgress.findMany({ where: { userId, completedAt: { not: null } }, select: { lessonSlug: true, bestScore: true } }),
    prisma.academyDay.findMany({ where: { userId }, select: { day: true } }),
    prisma.userBadge.findMany({ where: { userId, badge: { slug: { startsWith: "academy-" } } }, include: { badge: true } }),
  ]);
  const streak = streakFrom(days.map((row) => row.day), istDay());
  const earned = earnedBadges({
    completedSlugs: new Set(progress.map((row) => row.lessonSlug)),
    units: UNITS,
    streakLongest: streak.longest,
    perfectLesson: perfectNow || progress.some((row) => row.bestScore >= 100),
  });
  const have = new Set(held.map((row) => row.badge.slug));
  const fresh = earned.filter((slug) => !have.has(slug));
  if (!fresh.length) return [];
  await prisma.badge.createMany({ data: BADGES.filter((badge) => fresh.includes(badge.slug)).map((badge) => ({ slug: badge.slug, name: badge.name, description: badge.description })), skipDuplicates: true });
  const rows = await prisma.badge.findMany({ where: { slug: { in: fresh } } });
  await prisma.userBadge.createMany({ data: rows.map((badge) => ({ userId, badgeId: badge.id })), skipDuplicates: true });
  return BADGES.filter((badge) => fresh.includes(badge.slug)).map((badge) => ({ slug: badge.slug, name: badge.name, description: badge.description }));
}
