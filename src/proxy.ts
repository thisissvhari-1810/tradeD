import { NextResponse, type NextRequest } from "next/server";

const guarded = ["/terminal", "/markets", "/watchlist", "/orders", "/positions", "/holdings", "/funds", "/options", "/alerts", "/search", "/chart", "/prediction", "/admin", "/multi-account", "/super-admin"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/api") || pathname.startsWith("/_next")) return NextResponse.next();
  const needsSession = pathname === "/" || guarded.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  const session = request.cookies.get("td_session")?.value;
  if (needsSession && !session) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }
  if (pathname === "/login" && session) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
