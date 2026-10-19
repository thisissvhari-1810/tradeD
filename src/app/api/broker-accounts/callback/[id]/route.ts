import { handleConsentCallback } from "../handler";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleConsentCallback(request, (await context.params).id);
}
