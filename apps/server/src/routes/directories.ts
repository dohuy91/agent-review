import { nativeDirectoryPicker } from "../native-directory-picker.js";
import type { FastifyInstance } from "fastify";
import {
  DirectoryBrowseError,
  type DirectoryBrowser,
} from "../directory-browser.js";
export function installDirectoryRoutes(
  app: FastifyInstance,
  browser: DirectoryBrowser,
) {
  const nativePicker = nativeDirectoryPicker;
  // The chooser may own a pending HTTP request, so stop it before draining requests.
  app.addHook("preClose", async () => {
    nativePicker.cancel();
  });
  // Apply to successful and rejected directory responses, including auth errors.
  app.addHook("onSend", async (request, reply) => {
    if (
      [
        "/api/directory-roots",
        "/api/directory-listing",
        "/api/native-directory-picker",
      ].includes(request.url.split("?")[0]!)
    )
      reply.header("Cache-Control", "no-store");
  });

  app.route({
    method: ["POST", "DELETE"],
    url: "/api/native-directory-picker",
    handler: async (request, reply) => {
      if (!browser.nativePickerAvailable)
        return reply.code(404).send({
          error:
            "The native folder dialog is available only on the Mac running Agent Review outside Docker.",
        });
      if (
        Object.keys(request.query as Record<string, unknown>).length ||
        (request.body !== undefined &&
          (!request.body ||
            typeof request.body !== "object" ||
            Array.isArray(request.body) ||
            Object.keys(request.body).length))
      )
        return reply
          .code(400)
          .send({ error: "The folder dialog request must be empty." });
      const pickerId = request.headers["x-review-picker"] ?? "legacy";
      if (
        typeof pickerId !== "string" ||
        !/^[a-zA-Z0-9-]{1,80}$/.test(pickerId)
      )
        return reply
          .code(400)
          .send({ error: "Invalid folder dialog request identifier." });
      if (request.method === "DELETE") {
        nativePicker.cancel(pickerId);
        return reply.code(204).send();
      }
      try {
        return await nativePicker.choose(pickerId);
      } catch (error) {
        if (error instanceof DirectoryBrowseError)
          return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    },
  });
  app.get("/api/directory-roots", async (_request, reply) => {
    try {
      return await browser.listRoots();
    } catch (error) {
      if (error instanceof DirectoryBrowseError)
        return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
  app.get("/api/directory-listing", async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    if (
      Object.keys(query).some(
        (key) => !["rootId", "path", "cursor"].includes(key),
      ) ||
      typeof query.rootId !== "string" ||
      !query.rootId ||
      query.rootId.length > 100 ||
      (query.path !== undefined && typeof query.path !== "string") ||
      (query.cursor !== undefined && typeof query.cursor !== "string")
    )
      return reply.code(400).send({
        error:
          "A configured browsing root and relative folder path are required.",
      });
    try {
      return await browser.list(
        query.rootId,
        query.path as string | undefined,
        query.cursor as string | undefined,
      );
    } catch (error) {
      if (error instanceof DirectoryBrowseError)
        return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });
}
