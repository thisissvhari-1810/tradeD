import { loginSchema, mfaSchema } from "@/lib/schemas";
import { AppError, clientIp } from "@/lib/http";
import { mutation } from "@/server/http";
import { assertLoginAllowed, createSession, createTotp, hashToken, newToken, recordLoginAttempt, verifyPassword } from "@/server/auth";
import { prisma } from "@/lib/prisma";

export const POST = mutation(async (request) => {
  const body = await request.json().catch(() => null);
  if (body && typeof body === "object" && "challengeToken" in body) {
    const input = mfaSchema.parse(body);
    const challenge = await prisma.mfaChallenge.findUnique({ where: { tokenHash: hashToken(input.challengeToken) }, include: { user: true } });
    if (!challenge || challenge.expiresAt.getTime() < Date.now() || !challenge.user.mfaSecret) throw new AppError("The verification step expired. Sign in again.", 401);
    const totp = createTotp(challenge.user.email, challenge.user.mfaSecret);
    if (totp.validate({ token: input.code, window: 1 }) === null) throw new AppError("That code is not valid.", 401);
    await prisma.mfaChallenge.delete({ where: { id: challenge.id } });
    await prisma.user.update({ where: { id: challenge.userId }, data: { lastLoginAt: new Date() } });
    await createSession(challenge.userId, request);
    return Response.json({ ok: true, role: challenge.user.role });
  }
  const input = loginSchema.parse(body);
  const ip = clientIp(request);
  await assertLoginAllowed(input.email, ip);
  const user = await verifyPassword(input.email, input.password);
  if (!user) {
    await recordLoginAttempt(input.email, ip, false);
    throw new AppError("Email or password is incorrect.", 401);
  }
  await recordLoginAttempt(input.email, ip, true);
  if (user.mfaEnabled) {
    const token = newToken();
    await prisma.mfaChallenge.create({ data: { userId: user.id, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 5 * 60 * 1000) } });
    return Response.json({ mfaRequired: true, challengeToken: token });
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await createSession(user.id, request);
  return Response.json({ ok: true, role: user.role });
});
