import { zValidator } from "@hono/zod-validator";
import { setApplicationSchema } from "@tallo/contracts";
import { type Db, listApplications, removeApplication, setApplication } from "@tallo/db";
import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";

/** The application tracker: personal data, so it is read-token only and never cached. */
export function applicationRoutes({ db, read }: { db: Db; read: MiddlewareHandler }) {
  const routes = new Hono();
  const byJob = zValidator("param", z.object({ jobId: z.coerce.number().int().positive() }));

  routes.get("/v1/applications", read, async (c) => {
    c.header("cache-control", "private, no-store");
    return c.json(await listApplications(db));
  });

  routes.put(
    "/v1/applications/:jobId",
    read,
    byJob,
    zValidator("json", setApplicationSchema),
    async (c) => {
      const application = await setApplication(db, c.req.valid("param").jobId, c.req.valid("json"));
      if (!application) return c.json({ error: "That posting is no longer listed." }, 404);
      return c.json(application);
    },
  );

  routes.delete("/v1/applications/:jobId", read, byJob, async (c) => {
    await removeApplication(db, c.req.valid("param").jobId);
    return c.body(null, 204);
  });

  return routes;
}
