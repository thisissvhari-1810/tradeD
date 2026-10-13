import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/http";
import { kolkataParts } from "@/lib/market/clock";
import type { SessionUser } from "@/server/auth";

export async function touchStreak(userId: string) {
  const today = kolkataParts(new Date()).dateKey;
  const streak = await prisma.learningStreak.findUnique({ where: { userId } });
  if (streak?.lastActivity === today) return streak;
  const yesterday = kolkataParts(new Date(Date.now() - 24 * 60 * 60 * 1000)).dateKey;
  const current = streak && streak.lastActivity === yesterday ? streak.currentStreak + 1 : 1;
  const longest = Math.max(current, streak?.longestStreak ?? 0);
  return prisma.learningStreak.upsert({
    where: { userId },
    create: { userId, currentStreak: current, longestStreak: longest, lastActivity: today },
    update: { currentStreak: current, longestStreak: longest, lastActivity: today },
  });
}

async function award(userId: string, slug: string) {
  const badge = await prisma.badge.findUnique({ where: { slug } });
  if (!badge) return;
  await prisma.userBadge.upsert({
    where: { userId_badgeId: { userId, badgeId: badge.id } },
    create: { userId, badgeId: badge.id },
    update: {},
  });
}

export async function learningCatalog(userId: string) {
  const paths = await prisma.learningPath.findMany({
    include: { lessons: { where: { published: true }, orderBy: { sortOrder: "asc" }, include: { progress: { where: { userId } }, quiz: true } } },
    orderBy: { sortOrder: "asc" },
  });
  const attempts = await prisma.quizAttempt.findMany({ where: { userId, passed: true }, select: { quizId: true } });
  const passed = new Set(attempts.map((item) => item.quizId));
  return paths.map((path) => ({
    slug: path.slug,
    title: path.title,
    description: path.description,
    level: path.level,
    lessons: path.lessons.map((lesson) => ({
      slug: lesson.slug,
      title: lesson.title,
      summary: lesson.summary,
      minutes: lesson.minutes,
      completed: lesson.progress.length > 0,
      quizPassed: lesson.quiz ? passed.has(lesson.quiz.id) : false,
    })),
  }));
}

export async function getLesson(userId: string, slug: string) {
  const lesson = await prisma.lesson.findUnique({
    where: { slug },
    include: { path: true, quiz: { include: { questions: { orderBy: { sortOrder: "asc" } } } }, progress: { where: { userId } } },
  });
  if (!lesson || !lesson.published) throw new AppError("Lesson not found.", 404);
  const passed = lesson.quiz
    ? await prisma.quizAttempt.findFirst({ where: { userId, quizId: lesson.quiz.id, passed: true } })
    : null;
  return {
    slug: lesson.slug,
    title: lesson.title,
    summary: lesson.summary,
    body: lesson.body,
    level: lesson.level,
    minutes: lesson.minutes,
    videoUrl: safeVideoUrl(lesson.videoUrl),
    pathTitle: lesson.path.title,
    completed: lesson.progress.length > 0,
    quizPassed: Boolean(passed),
    questions: lesson.quiz?.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      options: question.options,
    })) ?? [],
  };
}

function safeVideoUrl(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

export async function completeLesson(userId: string, slug: string) {
  const lesson = await prisma.lesson.findUnique({ where: { slug } });
  if (!lesson?.published) throw new AppError("Lesson not found.", 404);
  await prisma.lessonProgress.upsert({
    where: { userId_lessonId: { userId, lessonId: lesson.id } },
    create: { userId, lessonId: lesson.id },
    update: {},
  });
  await touchStreak(userId);
  const progress = await prisma.lessonProgress.count({ where: { userId } });
  if (progress >= 3) await award(userId, "three-lessons");
  const pathLessons = await prisma.lesson.count({ where: { pathId: lesson.pathId, published: true } });
  const pathDone = await prisma.lessonProgress.count({ where: { userId, lesson: { pathId: lesson.pathId } } });
  if (pathDone >= pathLessons) await award(userId, `path-${lesson.level.toLowerCase()}`);
  return { completed: true };
}

export async function submitQuiz(userId: string, slug: string, answers: number[]) {
  const lesson = await prisma.lesson.findUnique({ where: { slug }, include: { quiz: { include: { questions: { orderBy: { sortOrder: "asc" } } } } } });
  if (!lesson?.quiz) throw new AppError("This lesson has no quiz.", 404);
  const questions = lesson.quiz.questions;
  if (answers.length !== questions.length) throw new AppError("Answer every question.");
  let correct = 0;
  const review = questions.map((question, index) => {
    const right = answers[index] === question.correctIndex;
    if (right) correct += 1;
    return { prompt: question.prompt, correct: right, explanation: question.explanation };
  });
  const score = Math.round((correct / questions.length) * 100);
  const passed = score >= 70;
  await prisma.quizAttempt.create({ data: { userId, quizId: lesson.quiz.id, score, passed, answers } });
  if (passed) {
    await completeLesson(userId, slug);
    if (score === 100) await award(userId, "perfect-quiz");
  }
  return { score, passed, review };
}

export async function saveJournal(
  user: SessionUser,
  input: { orderId?: string; thesis: string; expectedMove?: string; plannedExit?: string; riskReward?: string; emotion?: string; lesson?: string; mistakeTag?: string },
) {
  if (user.role !== "STUDENT") throw new AppError("Only students keep a personal trading journal.", 403);
  if (input.orderId) {
    const order = await prisma.order.findFirst({ where: { id: input.orderId, account: { userId: user.id } } });
    if (!order) throw new AppError("That order is not on your account.", 403);
  }
  const entry = await prisma.journalEntry.create({
    data: {
      userId: user.id,
      orderId: input.orderId,
      thesis: input.thesis,
      expectedMove: input.expectedMove ?? "",
      plannedExit: input.plannedExit ?? "",
      riskReward: input.riskReward ?? "",
      emotion: input.emotion ?? "NEUTRAL",
      lesson: input.lesson ?? "",
      mistakeTag: input.mistakeTag ?? "",
    },
  });
  await touchStreak(user.id);
  await award(user.id, "first-journal");
  if (input.plannedExit && input.riskReward) await award(user.id, "risk-plan");
  return entry;
}

export async function reviewJournal(actor: SessionUser, journalId: string, body: string) {
  const journal = await prisma.journalEntry.findUnique({ where: { id: journalId }, include: { user: { include: { memberships: true } } } });
  if (!journal) throw new AppError("Journal entry not found.", 404);
  if (actor.role === "INSTRUCTOR") {
    const classes = await prisma.class.findMany({ where: { instructorId: actor.id }, select: { id: true } });
    const classIds = new Set(classes.map((item) => item.id));
    if (!journal.user.memberships.some((member) => classIds.has(member.classId))) throw new AppError("This student is not in your class.", 403);
  } else if (actor.role !== "SUPER_ADMIN") {
    throw new AppError("You cannot review journals.", 403);
  }
  return prisma.journalFeedback.create({ data: { journalId, authorId: actor.id, body } });
}
