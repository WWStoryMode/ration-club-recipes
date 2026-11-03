import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, emptyValues, prettyDate, visitorForm, type Config, type FormValues, type Recipe, type RecipeSummary } from "./api";
import { Turnstile } from "./turnstile";
import "./styles.css";

// ---------------------------------------------------------------------------
// Routing: #/  ·  #/r/<id>  ·  #/r/<id>/edit  ·  #/new
// ---------------------------------------------------------------------------

type Route = { page: "list" } | { page: "view"; id: string } | { page: "edit"; id: string } | { page: "new" };

function parseRoute(hash: string): Route {
  const m = /^#\/r\/([A-Za-z0-9_-]{1,64})(\/edit)?$/.exec(hash);
  if (m) return m[2] ? { page: "edit", id: m[1]! } : { page: "view", id: m[1]! };
  if (hash === "#/new") return { page: "new" };
  return { page: "list" };
}

function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => {
      setHash(location.hash);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parseRoute(hash);
}

const go = (hash: string) => {
  location.hash = hash;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Per-browser drafts. Storage may be unavailable (private mode): everything still works without it. */
const drafts = {
  get(key: string): Draft | undefined {
    try {
      const raw = localStorage.getItem(`draft:${key}`);
      return raw ? (JSON.parse(raw) as Draft) : undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, d: Draft) {
    try {
      localStorage.setItem(`draft:${key}`, JSON.stringify(d));
    } catch {
      /* ignore */
    }
  },
  clear(key: string) {
    try {
      localStorage.removeItem(`draft:${key}`);
    } catch {
      /* ignore */
    }
  },
};

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  const reload = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    load().then(
      (data) => setState({ data, loading: false }),
      (e) => setState({ error: e instanceof ApiError ? e.message : "Something went wrong. Please reload the page.", loading: false }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

function Notice(props: { kind: "error" | "ok" | "info"; children: ReactNode; focus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.focus) ref.current?.focus();
  }, [props.focus, props.children]);
  return (
    <div ref={ref} tabIndex={-1} className={`notice notice-${props.kind}`} role={props.kind === "error" ? "alert" : "status"}>
      {props.children}
    </div>
  );
}

function Loading() {
  return <p className="muted" aria-live="polite">Loading…</p>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const route = useRoute();
  const [flash, setFlash] = useState<string>();
  const config = useLoad(() => api.config(), []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(undefined), 8000);
    return () => clearTimeout(t);
  }, [flash]);

  return (
    <>
      <header className="top">
        <a href="#/" className="brand">
          Ration Club Recipes
        </a>
      </header>
      <main className="page">
        {flash && <Notice kind="ok">{flash}</Notice>}
        {route.page === "list" && <RecipeList />}
        {route.page === "view" && <RecipeView id={route.id} />}
        {(route.page === "edit" || route.page === "new") &&
          (config.data ? (
            <RecipeEditor key={route.page === "edit" ? route.id : "new"} id={route.page === "edit" ? route.id : undefined} config={config.data} onDone={setFlash} />
          ) : config.error ? (
            <Notice kind="error">{config.error}</Notice>
          ) : (
            <Loading />
          ))}
      </main>
      <footer className="foot">
        <p>A community recipe booklet from Ration Club, our weekly communal meal at Newspeak House.</p>
      </footer>
    </>
  );
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function RecipeList() {
  const { data, error, loading, reload } = useLoad(() => api.recipes(), []);
  const [q, setQ] = useState("");
  const shown = useMemo(() => (data ?? []).filter((r) => r.title.toLowerCase().includes(q.trim().toLowerCase())), [data, q]);

  return (
    <>
      <div className="row-between">
        <h1>Recipes</h1>
        <a className="button" href="#/new">
          + Add a recipe
        </a>
      </div>
      {error && (
        <Notice kind="error">
          {error} <button className="link" onClick={reload}>Try again</button>
        </Notice>
      )}
      {loading && !data && <Loading />}
      {data && (
        <>
          {data.length > 6 && (
            <label className="field">
              <span className="label">Find a recipe</span>
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. curry" />
            </label>
          )}
          <ul className="cards">
            {shown.map((r: RecipeSummary) => (
              <li key={r.id}>
                <a className="card" href={`#/r/${r.id}`}>
                  {r.title}
                </a>
              </li>
            ))}
          </ul>
          {!shown.length && <p className="muted">{data.length ? "No recipe matches that." : "No recipes yet. Be the first to add one!"}</p>}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function RecipeView({ id }: { id: string }) {
  const { data: r, error, loading, reload } = useLoad(() => api.recipe(id), [id]);
  if (error)
    return (
      <>
        <BackLink />
        <Notice kind="error">
          {error} <button className="link" onClick={reload}>Try again</button>
        </Notice>
      </>
    );
  if (loading || !r) return <Loading />;
  const v = r.form.values;

  return (
    <article>
      <BackLink />
      <h1>{r.title}</h1>
      {r.form.editable ? (
        <>
          <dl className="facts">
            <Fact label="Head chef" value={v.headChef} />
            <Fact label="Helpers" value={v.helpers} />
            <Fact label="Cooked on" value={prettyDate(v.date)} />
            <Fact label="Serves" value={v.serves} />
            <Fact label="Cost" value={v.cost} />
          </dl>
          <h2>Ingredients</h2>
          {v.ingredients.length ? <ul className="list">{v.ingredients.map((x, i) => <li key={i}>{x}</li>)}</ul> : <Empty />}
          <h2>Method</h2>
          {v.method.length ? <ol className="list">{v.method.map((x, i) => <li key={i}>{x}</li>)}</ol> : <Empty />}
          {v.tips.length > 0 && (
            <>
              <h2>Tips &amp; substitutions</h2>
              <ul className="list">{v.tips.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </>
          )}
          {v.story && (
            <>
              <h2>The story</h2>
              {v.story.split(/\n\n+/).map((p, i) => <p key={i} className="pre">{p}</p>)}
            </>
          )}
          {v.other && (
            <>
              <h2>Other notes</h2>
              <p className="pre muted">{v.other}</p>
            </>
          )}
          <a className="button" href={`#/r/${r.id}/edit`}>
            Edit this recipe
          </a>
        </>
      ) : (
        <>
          {r.sections.map((s, i) => (
            <section key={s.id}>
              {i > 0 && <h2>{s.title}</h2>}
              {s.parts.map((p, j) =>
                p.type === "media" ? (
                  <p key={j} className="media">{p.kind === "image" ? "📷 A picture is here in the booklet." : "🎬 A video is here in the booklet."}</p>
                ) : (
                  p.markdown && <p key={j} className="pre">{p.markdown.replace(/\*\*|\\/g, "")}</p>
                ),
              )}
            </section>
          ))}
          <Notice kind="info">{r.form.reason}</Notice>
        </>
      )}
    </article>
  );
}

const BackLink = () => (
  <a className="back" href="#/">
    ← All recipes
  </a>
);
const Empty = () => <p className="muted">Nothing here yet. You can add it.</p>;
function Fact({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit / add
// ---------------------------------------------------------------------------

/** What the form holds: list fields as one textarea each (one item per line). */
interface Fields {
  title: string;
  headChef: string;
  helpers: string;
  date: string;
  serves: string;
  cost: string;
  ingredients: string;
  method: string;
  tips: string;
  story: string;
}
interface Draft {
  baseRev?: string;
  fields: Fields;
}

const toFields = (v: FormValues, title = ""): Fields => ({
  title,
  headChef: v.headChef,
  helpers: v.helpers,
  date: v.date,
  serves: v.serves,
  cost: v.cost,
  ingredients: v.ingredients.join("\n"),
  method: v.method.join("\n"),
  tips: v.tips.join("\n"),
  story: v.story,
});
const lines = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean);
const toForm = (f: Fields) =>
  visitorForm({ ...emptyValues(), headChef: f.headChef, helpers: f.helpers, date: f.date, serves: f.serves, cost: f.cost, ingredients: lines(f.ingredients), method: lines(f.method), tips: lines(f.tips), story: f.story });
const sameFields = (a: Fields, b: Fields) => JSON.stringify(a) === JSON.stringify(b);

function RecipeEditor({ id, config, onDone }: { id?: string; config: Config; onDone: (msg: string) => void }) {
  const isNew = !id;
  const draftKey = id ?? "new";
  const [recipe, setRecipe] = useState<Recipe>();
  const [loadError, setLoadError] = useState<string>();
  const [fields, setFields] = useState<Fields>(() => toFields(emptyValues()));
  const [original, setOriginal] = useState<Fields>(() => toFields(emptyValues()));
  const [baseRev, setBaseRev] = useState<string>();
  const [restored, setRestored] = useState(false);
  const [status, setStatus] = useState<{ kind: "error" | "info"; text: string; mine?: Fields }>();
  const [pending, setPending] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState("");
  const [resetKey, setResetKey] = useState(0);
  const [honeypot, setHoneypot] = useState("");
  const L = config.limits.form;

  const startFrom = useCallback(
    (r: Recipe | undefined) => {
      const base = r ? toFields(r.form.values, r.title) : toFields(emptyValues());
      setRecipe(r);
      setOriginal(base);
      setBaseRev(r?.form.rev);
      const d = drafts.get(draftKey);
      if (d && d.baseRev === r?.form.rev && !sameFields(d.fields, base)) {
        setFields(d.fields);
        setRestored(true);
      } else {
        setFields(base);
      }
    },
    [draftKey],
  );

  useEffect(() => {
    if (isNew) return startFrom(undefined);
    api.recipe(id).then(startFrom, (e) => setLoadError(e instanceof ApiError ? e.message : "Something went wrong. Please reload the page."));
  }, [id, isNew, startFrom]);

  const set = (k: keyof Fields) => (e: { target: { value: string } }) => {
    const next = { ...fields, [k]: e.target.value };
    setFields(next);
    if (sameFields(next, original)) drafts.clear(draftKey);
    else drafts.set(draftKey, { baseRev, fields: next });
  };

  if (loadError)
    return (
      <>
        <BackLink />
        <Notice kind="error">{loadError}</Notice>
      </>
    );
  if (!isNew && !recipe) return <Loading />;
  if (recipe && !recipe.form.editable)
    return (
      <>
        <a className="back" href={`#/r/${recipe.id}`}>← Back to the recipe</a>
        <Notice kind="info">{recipe.form.reason}</Notice>
      </>
    );

  if (pending)
    return (
      <>
        <Notice kind="ok" focus>
          {pending}
        </Notice>
        <a className="button" href={recipe ? `#/r/${recipe.id}` : "#/"}>
          {recipe ? "Back to the recipe" : "Back to all recipes"}
        </a>
      </>
    );

  const needsCheck = !!config.turnstileSiteKey;
  const changed = !sameFields(fields, original);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (isNew && !fields.title.trim()) return setStatus({ kind: "error", text: "Please give the recipe a name." });
    if (needsCheck && !token) return setStatus({ kind: "error", text: "Please complete the check that you're human (the box above the button), then save again." });
    setSaving(true);
    setStatus(undefined);
    const extra: Record<string, string> = { [config.honeypotField]: honeypot, ...(token ? { turnstileToken: token } : {}) };
    try {
      const out = isNew ? await api.add(fields.title.trim(), toForm(fields), extra) : await api.save(id!, baseRev!, toForm(fields), extra);
      drafts.clear(draftKey);
      if (out.kind === "pending") return setPending(out.message);
      onDone(isNew ? "Thanks! Your recipe has been added to the booklet." : "Thanks! Your changes are saved.");
      go(out.id ? `#/r/${out.id}` : "#/");
    } catch (err) {
      const ae = err instanceof ApiError ? err : new ApiError("internal", "Something went wrong. Please try again.", 0);
      if (ae.code === "conflict" && ae.latest && recipe) {
        // Someone saved first: load their version, and keep ours on screen to copy from.
        const mine = fields;
        startFrom(ae.latest as Recipe);
        drafts.clear(draftKey);
        setRestored(false);
        setStatus({ kind: "error", text: "Someone else changed this recipe while you were editing. Their version is now in the form. Your version is below, so you can copy what you need back in, then save again.", mine });
      } else {
        setStatus({ kind: "error", text: ae.message });
      }
    } finally {
      setSaving(false);
      setResetKey((k) => k + 1);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <a className="back" href={recipe ? `#/r/${recipe.id}` : "#/"}>
        ← {recipe ? "Back to the recipe" : "All recipes"}
      </a>
      <h1>{isNew ? "Add a recipe" : `Edit: ${recipe!.title}`}</h1>
      <p className="muted">Just type plain text. We'll format it for the booklet.{config.requiresApproval ? " An organiser checks every change before it appears." : ""}</p>

      {restored && (
        <Notice kind="info">
          We brought back the changes you hadn't saved.{" "}
          <button
            type="button"
            className="link"
            onClick={() => {
              setFields(original);
              drafts.clear(draftKey);
              setRestored(false);
            }}
          >
            Discard them
          </button>
        </Notice>
      )}

      {isNew && <Text label="Recipe name" value={fields.title} onChange={set("title")} max={config.limits.titleChars} required hint="e.g. Chickpea curry" />}

      <fieldset>
        <legend>Who cooked it</legend>
        <Text label="Head chef" value={fields.headChef} onChange={set("headChef")} max={L.name} />
        <Text label="Helpers" value={fields.helpers} onChange={set("helpers")} max={L.name} hint="Separate names with commas" />
        <label className="field">
          <span className="label">Date cooked</span>
          <input type="date" value={fields.date} onChange={set("date")} />
        </label>
      </fieldset>

      <fieldset>
        <legend>The basics</legend>
        <Text label="Serves" value={fields.serves} onChange={set("serves")} max={L.short} hint="e.g. 30 people" optional />
        <Text label="Approximate cost" value={fields.cost} onChange={set("cost")} max={L.short} hint="e.g. about £25" optional />
      </fieldset>

      <fieldset>
        <legend>The recipe</legend>
        <Lines label="Ingredients" value={fields.ingredients} onChange={set("ingredients")} hint="One ingredient per line, e.g. 1 kg rice" />
        <Lines label="Method" value={fields.method} onChange={set("method")} hint="One step per line. We'll number them for you." />
        <Lines label="Tips & substitutions" value={fields.tips} onChange={set("tips")} hint="One per line, e.g. Use lentils instead of meat" optional />
        <label className="field">
          <span className="label">
            The story behind the dish <span className="opt">(optional)</span>
          </span>
          <span className="hint">Where it comes from, who taught you, a memory. Leave a blank line between paragraphs.</span>
          <textarea rows={5} value={fields.story} onChange={set("story")} maxLength={L.story} />
        </label>
      </fieldset>

      {recipe?.form.values.other && (
        <div className="field">
          <span className="label">Other notes already in this recipe</span>
          <span className="hint">These are kept as they are. Organisers can change them in docs.plus.</span>
          <p className="pre muted box">{recipe.form.values.other}</p>
        </div>
      )}

      {/* Honeypot: hidden from people and screen readers. Bots that fill every field reveal themselves. */}
      <div className="hp" aria-hidden="true">
        <label>
          Website
          <input type="text" name={config.honeypotField} tabIndex={-1} autoComplete="off" value={honeypot} onChange={(e) => setHoneypot(e.target.value)} />
        </label>
      </div>

      {status && (
        <Notice kind={status.kind} focus>
          {status.text}
        </Notice>
      )}
      {status?.mine && (
        <details className="mine" open>
          <summary>Your version</summary>
          {(["headChef", "helpers", "serves", "cost", "ingredients", "method", "tips", "story"] as const).map((k) =>
            status.mine![k] ? (
              <div key={k}>
                <strong>{LABELS[k]}</strong>
                <p className="pre">{status.mine![k]}</p>
              </div>
            ) : null,
          )}
        </details>
      )}

      {needsCheck && <Turnstile siteKey={config.turnstileSiteKey!} onToken={setToken} resetKey={resetKey} onError={(text) => setStatus({ kind: "error", text })} />}

      <div className="actions">
        <button type="submit" className="button" disabled={saving || (!isNew && !changed)}>
          {saving ? "Saving…" : config.requiresApproval ? "Send for checking" : isNew ? "Add recipe" : "Save changes"}
        </button>
        {!isNew && !changed && !saving && <span className="muted">Change something to save.</span>}
      </div>
    </form>
  );
}

const LABELS: Record<keyof Fields, string> = {
  title: "Recipe name",
  headChef: "Head chef",
  helpers: "Helpers",
  date: "Date cooked",
  serves: "Serves",
  cost: "Approximate cost",
  ingredients: "Ingredients",
  method: "Method",
  tips: "Tips & substitutions",
  story: "Story",
};

type OnChange = (e: { target: { value: string } }) => void;

function Text(p: { label: string; value: string; onChange: OnChange; max: number; hint?: string; optional?: boolean; required?: boolean }) {
  return (
    <label className="field">
      <span className="label">
        {p.label} {p.optional && <span className="opt">(optional)</span>}
      </span>
      {p.hint && <span className="hint">{p.hint}</span>}
      <input type="text" value={p.value} onChange={p.onChange} maxLength={p.max} required={p.required} />
    </label>
  );
}

function Lines(p: { label: string; value: string; onChange: OnChange; hint: string; optional?: boolean }) {
  const rows = Math.min(14, Math.max(4, p.value.split("\n").length + 1));
  return (
    <label className="field">
      <span className="label">
        {p.label} {p.optional && <span className="opt">(optional)</span>}
      </span>
      <span className="hint">{p.hint}</span>
      <textarea rows={rows} value={p.value} onChange={p.onChange} />
    </label>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
