import { connection } from "next/server";
import { assertSameOrigin, jsonError } from "@/lib/http";

export type RouteContext<P extends Record<string, string> = Record<string, string>> = { params: Promise<P> };

export function mutation<C = unknown>(handler: (request: Request, context: C) => Promise<Response>) {
  return async (request: Request, context: C) => {
    try {
      await connection();
      assertSameOrigin(request);
      return await handler(request, context);
    } catch (error) {
      return jsonError(error);
    }
  };
}

export function query<C = unknown>(handler: (request: Request, context: C) => Promise<Response>) {
  return async (request: Request, context: C) => {
    try {
      await connection();
      return await handler(request, context);
    } catch (error) {
      return jsonError(error);
    }
  };
}
