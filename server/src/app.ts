import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ApiError, toApiError } from "./errors.js";
import type { RecipesService } from "./recipes.js";
import { LIMITS } from "./validate.js";

const SaveSection = z.object({
  baseRev: z.string().regex(/^[0-9a-f]{12}$/, "baseRev must be the 12-character rev you loaded"),
  texts: z.array(z.string().max(LIMITS.sectionChars * 2)).min(1).max(LIMITS.texts),
});
const AddRecipe = z.object({
  title: z.string().max(LIMITS.titleChars * 2),
  markdown: z.string().max(LIMITS.sectionChars * 2).default(""),
});
const SECTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

async function body<T>(c: { req: { json(): Promise<unknown> } }, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new ApiError("invalid", "The request wasn't valid JSON.");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new ApiError("invalid", parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return parsed.data;
}

function sectionId(raw: string): string {
  if (!SECTION_ID.test(raw)) throw new ApiError("not_found", "That recipe or section doesn't exist.");
  return raw;
}

export function createApp(deps: { recipes: RecipesService }) {
  const app = new Hono();

  app.use("/api/*", bodyLimit({ maxSize: 128 * 1024, onError: () => { throw new ApiError("invalid", "That's too much text to send at once."); } }));

  app.onError((err, c) => {
    const e = toApiError(err);
    return c.json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status as 400);
  });
  app.notFound((c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  app.get("/api/recipes", async (c) => c.json({ recipes: await deps.recipes.listRecipes() }));

  app.get("/api/recipes/:id", async (c) => c.json({ recipe: await deps.recipes.getRecipe(sectionId(c.req.param("id"))) }));

  app.put("/api/sections/:id", async (c) => {
    const { baseRev, texts } = await body(c, SaveSection);
    return c.json({ section: await deps.recipes.saveSection(sectionId(c.req.param("id")), baseRev, texts) });
  });

  app.post("/api/recipes", async (c) => {
    const { title, markdown } = await body(c, AddRecipe);
    return c.json({ recipe: await deps.recipes.addRecipe(title, markdown) }, 201);
  });

  return app;
}
