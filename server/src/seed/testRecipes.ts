/**
 * Fictional recipes for the TEST document. They copy the real booklet's shape (bold ### headings,
 * "**Head Chef: X**" / "**Support: …**" lines, bold "Ingredients"/"Method" paragraphs, a trailing date)
 * but contain no real people. Tests compare parsed docs.plus output against this definition.
 */
export interface TestRecipe {
  title: string;
  headChef?: string;
  support?: string[];
  ingredients?: string[];
  method?: string[];
  date?: string;
}

export const TEST_DOC_TITLE = "Ration Club Recipes: TEST DOC (fictional data)";

export const TEST_INTRO =
  "This is a test copy for developing the Ration Club Recipes app. Every name and recipe here is made up. Safe to edit.";

export const TEST_RECIPES: TestRecipe[] = [
  {
    title: "Lentil Soup",
    headChef: "Chef Alpha",
    support: ["Helper One", "Helper Two"],
    ingredients: ["500 g red lentils", "2 onions, diced", "1 tin chopped tomatoes", "2 l vegetable stock"],
    method: ["Soften the onions.", "Add lentils, tomatoes and stock.", "Simmer 25 minutes, then blend half."],
    date: "7 October 2026",
  },
  {
    title: "Tray Bake Vegetables",
    headChef: "Chef Bravo",
    support: ["Helper Three"],
    ingredients: ["3 kg mixed root vegetables", "Olive oil", "Salt and pepper"],
    method: ["Chop everything to a similar size.", "Toss in oil and seasoning.", "Roast at 200°C for 45 minutes."],
    date: "14 October 2026",
  },
  {
    // An empty template, like most recipes in the real booklet.
    title: "Mystery Stew",
    headChef: "Chef Charlie",
  },
];

/** Placeholder lines reproduced exactly as the real booklet writes them. */
function recipeMarkdown(r: TestRecipe): string {
  const parts = [`### **${r.title}**`];
  if (r.headChef) parts.push(`**Head Chef: ${r.headChef}**`);
  parts.push(`**Support: ${r.support?.length ? r.support.join(", ") : "???"}**`);
  if (r.ingredients || r.method) {
    parts.push("**Ingredients**");
    if (r.ingredients) parts.push(r.ingredients.map((i) => `- ${i}`).join("\n"));
    parts.push("**Method**");
    if (r.method) parts.push(r.method.map((m, i) => `${i + 1}. ${m}`).join("\n"));
  }
  if (r.date) parts.push(r.date);
  return parts.join("\n\n");
}

/** Body markdown for create_document (the title becomes the # heading). */
export function testDocMarkdown(): string {
  return [TEST_INTRO, ...TEST_RECIPES.map(recipeMarkdown)].join("\n\n") + "\n";
}
