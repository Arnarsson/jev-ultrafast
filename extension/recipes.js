// Learned steps ("recipes"): replay what worked last time on the same page without model calls.
// Pure functions; the panel stores recipes in chrome.storage.local.

export const MAX_RECIPES = 50;

export function pageKey(url = "") {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

// Steps worth keeping: executed, with a visible effect, not waits.
export function recordRecipe(state, day) {
  const steps = state.history
    .filter((h) => h.kind !== "wait" && h.page_changed !== false)
    .map((h) => ({ kind: h.kind, role: h.role ?? null, label: h.action, operation: h.operation, text: h.text ?? null }));
  if (!steps.length || !state.start_url) return null;
  return { key: pageKey(state.start_url), goal: state.goal, day, steps, saved_at: Date.now() };
}

export function saveRecipe(recipes, recipe) {
  const rest = recipes.filter((r) => !(r.key === recipe.key && r.goal === recipe.goal));
  return [recipe, ...rest].slice(0, MAX_RECIPES);
}

// Exact goal on the same day replays everything; otherwise the newest recipe for the page, structural steps only.
export function findRecipe(recipes, url, goal, day) {
  const key = pageKey(url);
  const exact = recipes.find((r) => r.key === key && r.goal === goal && r.day === day);
  if (exact) return { recipe: exact, exact: true };
  const latest = recipes.find((r) => r.key === key);
  return latest ? { recipe: latest, exact: false } : null;
}

// A step that does not depend on the goal's values: fields (text is regenerated), and clicks whose
// label has no digits (dates, prices, counts) and no word that was typed (e.g. "Tokyo, Japan").
export function structural(step, recipe) {
  if (step.kind === "fill") return true;
  if (/\d/.test(step.label)) return false;
  const typed = new Set(
    recipe.steps.flatMap((s) => (s.text ?? "").toLowerCase().split(/\W+/)).filter((w) => w.length >= 3),
  );
  return !step.label.toLowerCase().split(/\W+/).some((w) => typed.has(w));
}

// Labels gain or lose loaded detail between runs ("Oct 1, 2026 ????" vs "Oct 1, 2026 , 16380 kr"):
// match when one label, minus trailing placeholder marks, starts the other.
const core = (label) => label.replace(/[\s?.…]+$/, "");
export const sameLabel = (a, b) => {
  const [x, y] = [core(a), core(b)];
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  // "Page 1" must not match "Page 10": the shorter label has to end at a word boundary.
  return short.length >= 3 && long.startsWith(short) && !/[\p{L}\p{N}]/u.test(long[short.length] ?? "");
};

export const sameStep = (step, action) =>
  action.kind === step.kind && (action.role ?? null) === step.role && sameLabel(action.label, step.label);
