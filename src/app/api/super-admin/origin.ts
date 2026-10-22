/** Absolute origin for links in emails/messages: the configured app URL, else the request's own origin. */
export function appOrigin(request: Request) {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, "");
  return configured || new URL(request.url).origin;
}
