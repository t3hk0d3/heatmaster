// The import-boundary and purity rules of STYLEGUIDE.md. They need no type information, so the
// lint tests load this file alone; eslint.config.js adds it to the full configuration.
import { builtinModules } from "node:module";
import path from "node:path";
import tseslint from "typescript-eslint";

const ROOT = import.meta.dirname;

const TEST_ALLOWED_BARE = new Set(["vitest", "@fast-check/vitest", "fast-check", "eslint", "vite"]);
const CORE = "@heatmaster/core";

function isBuiltin(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

function isInside(file, folder) {
  const relative = path.relative(folder, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Where a file stands: which package, and whether it is a test file.
function locate(filename) {
  const relative = path.relative(ROOT, filename);
  const match = /^packages[\\/](core|server|web)[\\/](.*)$/.exec(relative);
  if (match === null) return undefined;
  const pkg = match[1];
  const rest = match[2];
  const isTest = /\.test\.ts$/.test(rest) || rest.startsWith("test/") || rest.startsWith("test\\");
  return { pkg, isTest, dir: path.join(ROOT, "packages", pkg), inSrc: rest.startsWith("src") };
}

// Returns a message id when the import is not allowed, or undefined when it is.
function verdict(where, filename, specifier, typeOnly) {
  const { pkg, isTest, dir } = where;
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(filename), specifier);
    const allowed = [];
    if (pkg === "core") {
      allowed.push(path.join(dir, "src"));
      if (isTest) allowed.push(path.join(dir, "test"));
    } else {
      allowed.push(dir);
    }
    if (isTest) allowed.push(path.join(ROOT, "vitest.setup.ts"));
    return allowed.some((folder) => isInside(target, folder)) ? undefined : "relativeOutside";
  }
  if (specifier === CORE) {
    if (pkg === "core") return "workspace";
    if (pkg === "web" && !typeOnly) return "webValue";
    return undefined;
  }
  if (specifier.startsWith("@heatmaster/")) return "workspace";
  if (pkg === "core") {
    if (!isTest) return "coreBare";
    const name = specifier
      .split("/")
      .slice(0, specifier.startsWith("@") ? 2 : 1)
      .join("/");
    return isBuiltin(specifier) || TEST_ALLOWED_BARE.has(name) ? undefined : "coreBare";
  }
  return undefined;
}

const boundary = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      relativeOutside: "A relative import must stay inside the places this file may reach.",
      workspace:
        "Another package is imported by its name, through its index, and only where the styleguide allows.",
      webValue: "The web package imports only types from @heatmaster/core (use `import type`).",
      coreBare: "Nothing in core imports from outside core.",
    },
  },
  create(context) {
    const where = locate(context.filename);
    if (where === undefined) return {};
    // Only the source of core and the files of the other packages are restricted;
    // core's own configuration files are not.
    if (where.pkg === "core" && !where.inSrc && !where.isTest) return {};
    function check(node, typeOnly) {
      const source = node.source;
      if (source === null || source === undefined || source.type !== "Literal") return;
      if (typeof source.value !== "string") return;
      const message = verdict(where, context.filename, source.value, typeOnly);
      if (message !== undefined) context.report({ node: source, messageId: message });
    }
    return {
      ImportDeclaration: (node) => {
        check(node, node.importKind === "type");
      },
      ExportAllDeclaration: (node) => {
        check(node, node.exportKind === "type");
      },
      ExportNamedDeclaration: (node) => {
        check(node, node.exportKind === "type");
      },
      ImportExpression: (node) => {
        check(node, false);
      },
    };
  },
};

const coreClockAndEffects = [
  { name: "Date", message: "The core never reads the clock." },
  { name: "setTimeout", message: "The core never waits." },
  { name: "setInterval", message: "The core never waits." },
  { name: "process", message: "The core has no side effects." },
  { name: "console", message: "The core never logs." },
];

export const boundaryConfigs = [
  {
    files: ["**/*.ts", "**/*.js"],
    languageOptions: { parser: tseslint.parser },
    plugins: { heatmaster: { rules: { boundary } } },
    rules: { "heatmaster/boundary": "error" },
  },
  {
    files: ["packages/core/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-globals": ["error", ...coreClockAndEffects],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "The core never reads the clock." },
        { object: "Temporal", property: "Now", message: "The core never reads the clock." },
        { object: "Math", property: "random", message: "The core is deterministic." },
      ],
    },
  },
];

export default boundaryConfigs;
