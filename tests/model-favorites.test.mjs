import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const buildResult = await build({
  entryPoints: ["src/lib/model-favorites.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
});
const compiledModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function("module", "exports", "require", buildResult.outputFiles[0].text)(
  compiledModule,
  compiledModule.exports,
  require,
);

const {
  filterModels,
  normalizeFavoriteModelRefs,
  orderModelsWithFavorites,
  toggleFavoriteModelRef,
} = compiledModule.exports;
const settingsSource = await readFile("src/components/DashboardViews.tsx", "utf8");
const pickerBuild = await build({
  entryPoints: ["src/components/ModelPickerPopover.tsx"],
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  logLevel: "silent",
  external: ["react", "react-dom"],
});
const pickerModule = { exports: {} };
new Function("module", "exports", "require", pickerBuild.outputFiles[0].text)(
  pickerModule,
  pickerModule.exports,
  require,
);
const { ModelPickerPopover } = pickerModule.exports;

const models = [
  { provider: "openai", id: "gpt-5.6", name: "GPT 5.6" },
  { provider: "anthropic", id: "claude-5", name: "Claude 5" },
  { provider: "ollama", id: "qwen3:latest", name: "Qwen 3" },
];

test("favorite model references are bounded, complete, unique, and stable", () => {
  assert.deepEqual(normalizeFavoriteModelRefs([
    " openai/gpt-5.6 ",
    "openai/gpt-5.6",
    "incomplete",
    null,
    "ollama/qwen3:latest",
  ]), ["openai/gpt-5.6", "ollama/qwen3:latest"]);
});

test("favorites stay above provider sorting and preserve the chosen favorite order", () => {
  assert.deepEqual(
    orderModelsWithFavorites(models, ["ollama/qwen3:latest", "openai/gpt-5.6"]).map((model) => `${model.provider}/${model.id}`),
    ["ollama/qwen3:latest", "openai/gpt-5.6", "anthropic/claude-5"],
  );
});

test("search matches provider, display name, and id after favorite ordering", () => {
  assert.deepEqual(filterModels(models, "openai", ["ollama/qwen3:latest"]).map((model) => model.id), ["gpt-5.6"]);
  assert.deepEqual(filterModels(models, "qwen", ["ollama/qwen3:latest"]).map((model) => model.id), ["qwen3:latest"]);
});

test("toggle adds and removes one validated favorite", () => {
  assert.deepEqual(toggleFavoriteModelRef([], "openai/gpt-5.6"), ["openai/gpt-5.6"]);
  assert.deepEqual(toggleFavoriteModelRef(["openai/gpt-5.6"], "openai/gpt-5.6"), []);
  assert.deepEqual(toggleFavoriteModelRef([], "invalid"), []);
});

test("both Settings model defaults use the shared searchable favorite picker", () => {
  assert.match(settingsSource, /openModelPicker === "main" \? <ModelPickerPopover/);
  assert.match(settingsSource, /openModelPicker === "subagent" \? <ModelPickerPopover/);
  assert.match(settingsSource, /favoriteModels: toggleFavoriteModelRef\(current\.preferences\.favoriteModels, ref\)/);
});

test("the shared picker renders searchable favorites first with accessible selection state", () => {
  const markup = renderToStaticMarkup(createElement(ModelPickerPopover, {
    models,
    active: "openai/gpt-5.6",
    favorites: ["openai/gpt-5.6"],
    onChoose: () => undefined,
    onToggleFavorite: () => undefined,
  }));
  assert.match(markup, /aria-label="Rechercher un modèle"/);
  assert.match(markup, /aria-label="Modèles favoris"/);
  assert.match(markup, /aria-pressed="true"/);
  assert.match(markup, /openai · gpt-5\.6/);
  assert.ok(markup.indexOf("Favoris") < markup.indexOf("anthropic"));
});
