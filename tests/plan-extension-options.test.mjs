import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

// The extension imports only what Prime Agent's loader provides. Stub those
// host modules so the pure helpers can be exercised without a runtime, which
// is exactly what the module header promises.
const hostStubs = {
  name: "prime-agent-host-stubs",
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^(typebox|@earendil-works\/.*)$/ }, (args) => ({
      path: args.path,
      namespace: "host-stub",
    }));
    pluginBuild.onLoad({ filter: /.*/, namespace: "host-stub" }, () => ({
      contents: `
        const schema = (options) => ({ ...options });
        export const Type = {
          Object: schema,
          Array: schema,
          String: schema,
          Integer: schema,
          Boolean: schema,
          Optional: schema,
        };
        export const StringEnum = schema;
      `,
      loader: "js",
    }));
  },
};

const buildResult = await build({
  entryPoints: ["src-tauri/assets/prime-orbit-plan-mode.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  write: false,
  logLevel: "silent",
  plugins: [hostStubs],
});
const compiledModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function("module", "exports", "require", buildResult.outputFiles[0].text)(
  compiledModule,
  compiledModule.exports,
  require,
);
const { composeOptionLabels, normalizePlanQuestionOptions, resolveSelection } = compiledModule.exports;

test("an option carrying only a label stays askable", () => {
  // Observed in a real session: the model sent labels and descriptions but no
  // value, and the whole question failed validation, costing a retry and
  // showing the user a failed tool step.
  const options = normalizePlanQuestionOptions([
    { label: "A : Plan minimal", description: "Un document court" },
    { label: "B : Plan complet" },
  ]);
  assert.deepEqual(options, [
    { value: "A : Plan minimal", label: "A : Plan minimal", description: "Un document court" },
    { value: "B : Plan complet", label: "B : Plan complet" },
  ]);
});

test("an option carrying only a value stays askable", () => {
  // The mirror-image failure from another real session: labels were dropped
  // and only values survived.
  assert.deepEqual(
    normalizePlanQuestionOptions([{ value: "notes_cli" }]),
    [{ value: "notes_cli", label: "notes_cli" }],
  );
});

test("an option carrying neither is still refused, by index", () => {
  assert.throws(
    () => normalizePlanQuestionOptions([{ label: "ok" }, { description: "orpheline" }]),
    /options\[1\]/u,
  );
  // Whitespace is not content.
  assert.throws(() => normalizePlanQuestionOptions([{ label: "   ", value: "" }]), /options\[0\]/u);
});

test("normalized options round-trip through the selection dialog", () => {
  const options = normalizePlanQuestionOptions([
    { label: "A : Plan minimal", description: "Un document court" },
    { label: "B : Plan complet" },
  ]);
  const labels = composeOptionLabels(options);
  const selection = resolveSelection(options, labels[0]);
  assert.equal(selection.type, "option");
  // The reported value is the label the user actually saw, never an empty
  // string that downstream payload consumers would have to guess about.
  assert.equal(selection.value, "A : Plan minimal");
  assert.equal(selection.label, "A : Plan minimal");
});
