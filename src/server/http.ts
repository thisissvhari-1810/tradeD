import { connection } from "next/server";
import { assertSameOrigin, jsonError } from "@/lib/http";

export function mutation(handler: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    try {
      await connection();
      assertSameOrigin(request);
      return await handler(request);
    } catch (error) {
      return jsonError(error);
    }
  };
}

export function query(handler: (request: Request) => Promise<Response>) {
  return async (request: Request) => {
    try {
      await connection();
      return await handler(request);
    } catch (error) {
      return jsonError(error);
    }
  };
}
