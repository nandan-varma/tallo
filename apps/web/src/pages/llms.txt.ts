import { llmsText } from "@tallo/contracts";

// Static: built once, served as a file. The text is generated from the public API's own schemas.
export const prerender = true;

export const GET = () =>
  new Response(llmsText(), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600",
    },
  });
