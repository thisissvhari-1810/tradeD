import { handleConsentCallback } from "./handler";

export const GET = (request: Request) => handleConsentCallback(request, null);
