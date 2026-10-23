import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";

const COOKIE = "tallo_key";
const digest = async (value: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** v1 is private: everything needs the access key, given once as `?key=` and kept in a cookie. */
export const onRequest = defineMiddleware(async (context, next) => {
  const expected = await digest(env.ACCESS_TOKEN);
  if (context.cookies.get(COOKIE)?.value === expected) return next();

  const key = context.url.searchParams.get("key");
  if (key && (await digest(key)) === expected) {
    context.cookies.set(COOKIE, expected, {
      httpOnly: true,
      secure: context.url.protocol === "https:",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    const clean = new URL(context.url);
    clean.searchParams.delete("key");
    return context.redirect(clean.pathname + clean.search);
  }
  return new Response("Private. Add ?key=… to continue.", {
    status: 401,
    headers: { "content-type": "text/plain" },
  });
});
