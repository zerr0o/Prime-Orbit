import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

function createHookHarness() {
  const refs = [];
  const effects = [];
  let hookIndex = 0;
  let effectIndex = 0;
  let pendingEffects = [];

  return {
    beginRender() {
      hookIndex = 0;
      effectIndex = 0;
      pendingEffects = [];
    },
    useRef(initialValue) {
      const index = hookIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useId() {
      return `modal-test-${hookIndex++}`;
    },
    useEffect(create, dependencies) {
      pendingEffects.push({ index: effectIndex++, create, dependencies });
    },
    flushEffects() {
      for (const pending of pendingEffects) {
        const previous = effects[pending.index];
        const changed = !previous
          || !pending.dependencies
          || !previous.dependencies
          || pending.dependencies.length !== previous.dependencies.length
          || pending.dependencies.some((dependency, index) => !Object.is(dependency, previous.dependencies[index]));
        if (!changed) continue;
        previous?.cleanup?.();
        effects[pending.index] = {
          dependencies: pending.dependencies,
          cleanup: pending.create(),
        };
      }
      pendingEffects = [];
    },
    unmount() {
      for (const effect of effects) effect?.cleanup?.();
      effects.length = 0;
      refs.length = 0;
    },
  };
}

const hooks = createHookHarness();
globalThis.__primeOrbitModalHooks = hooks;

const mockPlugin = {
  name: "modal-react-harness",
  setup(builder) {
    builder.onResolve({ filter: /^react$/ }, () => ({ path: "react", namespace: "modal-test" }));
    builder.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: "jsx-runtime", namespace: "modal-test" }));
    builder.onResolve({ filter: /^lucide-react$/ }, () => ({ path: "lucide", namespace: "modal-test" }));
    builder.onResolve({ filter: /^\.\.\/i18n$/ }, () => ({ path: "i18n", namespace: "modal-test" }));
    builder.onLoad({ filter: /^react$/, namespace: "modal-test" }, () => ({
      loader: "js",
      contents: `
        export const useEffect = (...args) => globalThis.__primeOrbitModalHooks.useEffect(...args);
        export const useId = (...args) => globalThis.__primeOrbitModalHooks.useId(...args);
        export const useRef = (...args) => globalThis.__primeOrbitModalHooks.useRef(...args);
      `,
    }));
    builder.onLoad({ filter: /^jsx-runtime$/, namespace: "modal-test" }, () => ({
      loader: "js",
      contents: `
        export const Fragment = Symbol.for("modal-test.fragment");
        export const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
        export const jsxs = jsx;
      `,
    }));
    builder.onLoad({ filter: /^lucide$/, namespace: "modal-test" }, () => ({
      loader: "js",
      contents: `
        export const LoaderCircle = () => null;
        export const X = () => null;
      `,
    }));
    builder.onLoad({ filter: /^i18n$/, namespace: "modal-test" }, () => ({
      loader: "js",
      contents: `export const useI18n = () => ({ t: (key) => key });`,
    }));
  },
};

const buildResult = await build({
  entryPoints: ["src/components/Ui.tsx"],
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  write: false,
  logLevel: "silent",
  plugins: [mockPlugin],
});
const compiledModule = { exports: {} };
const require = createRequire(import.meta.url);
new Function("module", "exports", "require", buildResult.outputFiles[0].text)(
  compiledModule,
  compiledModule.exports,
  require,
);

const { Modal } = compiledModule.exports;

class FakeElement {
  constructor(name) {
    this.name = name;
    this.isConnected = true;
    this.focusCount = 0;
  }

  focus() {
    this.focusCount += 1;
    globalThis.document.activeElement = this;
  }
}

class FakeDialog extends FakeElement {
  constructor(preferredControl, firstControl) {
    super("dialog");
    this.preferredControl = preferredControl;
    this.firstControl = firstControl;
  }

  contains(element) {
    return element === this.preferredControl || element === this.firstControl || element === this;
  }

  querySelector(selector) {
    if (selector === "[data-modal-autofocus]") return this.preferredControl;
    if (selector === "[autofocus]") return null;
    return this.firstControl;
  }

  querySelectorAll() {
    return [this.firstControl, this.preferredControl];
  }
}

function findNode(node, predicate) {
  if (!node || typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return undefined;
}

test("a periodic parent rerender does not steal focus from a rename field", () => {
  const originalHTMLElement = globalThis.HTMLElement;
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  const externalTrigger = new FakeElement("rename trigger");
  const closeButton = new FakeElement("close");
  const renameInput = new FakeElement("rename input");
  const dialog = new FakeDialog(renameInput, closeButton);
  const frames = new Map();
  const listeners = new Map();
  let nextFrame = 1;
  let scheduledFrames = 0;
  let staleCloseCalls = 0;
  let latestCloseCalls = 0;

  globalThis.HTMLElement = FakeElement;
  globalThis.document = { activeElement: externalTrigger };
  globalThis.window = {
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      scheduledFrames += 1;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      frames.delete(id);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };

  try {
    hooks.beginRender();
    const firstTree = Modal({ title: "Rename", description: "Rename this item", onClose: () => { staleCloseCalls += 1; }, children: null });
    const dialogNode = findNode(firstTree, (node) => node.type === "section" && node.props?.role === "dialog");
    assert.ok(dialogNode, "the accessible dialog remains present");
    assert.equal(dialogNode.props["aria-modal"], "true");
    assert.ok(dialogNode.props["aria-labelledby"]);
    assert.ok(dialogNode.props["aria-describedby"]);
    dialogNode.props.ref.current = dialog;
    hooks.flushEffects();
    for (const callback of frames.values()) callback();
    frames.clear();

    assert.equal(globalThis.document.activeElement, renameInput, "the explicitly nominated field receives initial focus");
    assert.equal(closeButton.focusCount, 0);

    // App.tsx refreshes repository state on a timer. Each refresh creates a
    // fresh inline onClose callback, but must not restart the modal lifecycle.
    for (let refresh = 0; refresh < 4; refresh += 1) {
      hooks.beginRender();
      Modal({ title: "Rename", onClose: () => { latestCloseCalls += 1; }, children: null });
      hooks.flushEffects();
      assert.equal(globalThis.document.activeElement, renameInput);
    }

    assert.equal(scheduledFrames, 1, "initial focus is scheduled once, not after every timer-driven rerender");
    assert.equal(closeButton.focusCount, 0, "the close button never takes focus during editing");

    listeners.get("keydown")?.({ key: "Escape", preventDefault() {} });
    assert.equal(staleCloseCalls, 0, "the mount-time callback is not retained");
    assert.equal(latestCloseCalls, 1, "Escape uses the latest close callback without re-registering the listener");

    hooks.unmount();
    assert.equal(globalThis.document.activeElement, externalTrigger, "closing restores focus to the control that opened the modal");
    assert.equal(listeners.has("keydown"), false);
  } finally {
    globalThis.HTMLElement = originalHTMLElement;
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});
