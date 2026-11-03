/** Talks only to our own backend under /api. The browser never calls docs.plus. */

export interface FormValues {
  headChef: string;
  helpers: string;
  date: string; // YYYY-MM-DD or ""
  serves: string;
  cost: string;
  ingredients: string[];
  method: string[];
  tips: string[];
  story: string;
  other: string; // read-only: text already in the recipe that fits no field
  photos: Photo[]; // pictures/videos at the end of the recipe, in order
}
export interface Photo {
  kind: string; // "image", "youtube", …
  caption: string;
  url?: string; // known only for photos added through this site
}
export interface NewPhoto {
  url: string;
  caption: string;
}
/** What the page sends: a caption per existing photo (in order) and links for new photos. Never `other`. */
export type VisitorForm = Omit<FormValues, "other" | "photos"> & { photos: Array<{ caption: string }>; newPhotos: NewPhoto[] };

export interface RecipeSummary {
  id: string;
  title: string;
}

export type Part = { type: "text"; markdown: string } | { type: "media"; kind: string };

export interface Recipe extends RecipeSummary {
  sections: Array<{ id: string; title: string; level: number; parts: Part[] }>;
  form: { editable: boolean; reason?: string; rev: string; values: FormValues };
}

export interface Config {
  turnstileSiteKey: string | null;
  honeypotField: string;
  requiresApproval: boolean;
  limits: { titleChars: number; form: { name: number; short: number; line: number; lines: number; story: number; caption: number }; photos: { perSave: number; perRecipe: number } };
}

/** Saved now, or waiting for an organiser. */
export type SaveOutcome = { kind: "saved"; id?: string } | { kind: "pending"; message: string };

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly latest?: unknown,
  ) {
    super(message);
  }
}

const OFFLINE = "We couldn't reach the recipe booklet. Check your internet connection and try again.";

async function request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("offline", OFFLINE, 0);
  }
  const data = await res.json().catch(() => undefined);
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; latest?: unknown } } | undefined)?.error;
    throw new ApiError(e?.code ?? "internal", e?.message ?? "Something went wrong on our side. Please try again in a moment.", res.status, e?.latest);
  }
  return { status: res.status, data: data as T };
}

export const api = {
  config: async () => (await request<Config>("GET", "/config")).data,
  recipes: async () => (await request<{ recipes: RecipeSummary[] }>("GET", "/recipes")).data.recipes,
  recipe: async (id: string) => (await request<{ recipe: Recipe }>("GET", `/recipes/${encodeURIComponent(id)}`)).data.recipe,

  async save(id: string, baseRev: string, form: VisitorForm, extra: Record<string, string>): Promise<SaveOutcome> {
    const r = await request<{ message?: string }>("PUT", `/recipes/${encodeURIComponent(id)}`, { baseRev, form, ...extra });
    return r.status === 202 ? { kind: "pending", message: r.data.message ?? "" } : { kind: "saved", id };
  },

  async add(title: string, form: VisitorForm, extra: Record<string, string>): Promise<SaveOutcome> {
    const r = await request<{ message?: string; recipe?: { id: string } }>("POST", "/recipes", { title, form, ...extra });
    return r.status === 202 ? { kind: "pending", message: r.data.message ?? "" } : { kind: "saved", id: r.data.recipe?.id };
  },
};

export const emptyValues = (): FormValues => ({ headChef: "", helpers: "", date: "", serves: "", cost: "", ingredients: [], method: [], tips: [], story: "", other: "", photos: [] });

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-09-30" → "30 September 2026" */
export function prettyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : "";
}
