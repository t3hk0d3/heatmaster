import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CORE_SRC = path.join(ROOT, "packages/core/src");

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

function importsOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(
    /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g,
  )) {
    found.push(match[1] ?? "");
  }
  return found;
}

const linter = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.boundaries.js"),
});

/** The messages ESLint gives a sample text placed at a file path inside the repository. */
async function lint(file: string, code: string): Promise<string[]> {
  const [result] = await linter.lintText(code, { filePath: path.join(ROOT, file) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? message.message);
}

describe("core package", () => {
  describe("import graph", () => {
    describe("Always", () => {
      it("every import in a non-test file under packages/core/src is a relative path that stays inside packages/core/src", () => {
        for (const file of sourceFiles(CORE_SRC)) {
          for (const specifier of importsOf(readFileSync(file, "utf8"))) {
            expect(specifier.startsWith("."), `${file} imports ${specifier}`).toBe(true);
            const target = path.resolve(path.dirname(file), specifier);
            expect(path.relative(CORE_SRC, target).startsWith(".."), `${file} → ${specifier}`).toBe(
              false,
            );
          }
        }
      });
    });
  });

  describe("lint rules", () => {
    describe('With a file in packages/core/src that imports "node:fs", "fastify" or "@heatmaster/server"', () => {
      it("ESLint reports an error", async () => {
        for (const specifier of ["node:fs", "fastify", "@heatmaster/server"]) {
          const messages = await lint(
            "packages/core/src/x.ts",
            `import x from "${specifier}";\nexport default x;\n`,
          );
          expect(messages, specifier).toEqual(["heatmaster/boundary"]);
        }
      });
    });

    describe("With a file in packages/core/src that uses Date.now(), Temporal.Now, setTimeout or Math.random()", () => {
      it("ESLint reports an error", async () => {
        const uses: [string, string][] = [
          ["Date.now()", "no-restricted-globals"],
          ["Temporal.Now.instant()", "no-restricted-properties"],
          ["setTimeout(() => undefined, 1)", "no-restricted-globals"],
          ["setInterval(() => undefined, 1)", "no-restricted-globals"],
          ["Math.random()", "no-restricted-properties"],
          ["process.env", "no-restricted-globals"],
          ["console.log(1)", "no-restricted-globals"],
        ];
        for (const [use, rule] of uses) {
          const messages = await lint("packages/core/src/x.ts", `export const x = ${use};\n`);
          expect(messages, use).toContain(rule);
          expect(messages, use).not.toContain("Parsing error");
        }
      });
    });

    describe('With packages/core/src/x.test.ts importing "vitest"', () => {
      it("ESLint reports nothing", async () => {
        expect(
          await lint(
            "packages/core/src/x.test.ts",
            'import { it } from "vitest";\nit("a", () => {});\n',
          ),
        ).toEqual([]);
      });
    });

    describe('With a file in packages/server/src that imports "@heatmaster/core"', () => {
      it("ESLint reports nothing", async () => {
        expect(
          await lint(
            "packages/server/src/x.ts",
            'import { x } from "@heatmaster/core";\nexport { x };\n',
          ),
        ).toEqual([]);
      });
    });

    describe('With a file in packages/server/src that imports "../../core/src/model.ts"', () => {
      it("ESLint reports an error", async () => {
        expect(
          await lint(
            "packages/server/src/x.ts",
            'import { x } from "../../core/src/model.ts";\nexport { x };\n',
          ),
        ).toEqual(["heatmaster/boundary"]);
      });
    });

    describe('With a file in packages/web/src that uses `import type` from "@heatmaster/core"', () => {
      it("ESLint reports nothing", async () => {
        expect(
          await lint(
            "packages/web/src/x.ts",
            'import type { X } from "@heatmaster/core";\nexport type Y = X;\n',
          ),
        ).toEqual([]);
      });
    });

    describe('With a file in packages/web/src that imports a value from "@heatmaster/core", or anything from "@heatmaster/server"', () => {
      it("ESLint reports an error", async () => {
        for (const code of [
          'import { x } from "@heatmaster/core";\nexport { x };\n',
          'import { type X } from "@heatmaster/core";\nexport type Y = X;\n',
          'import type { X } from "@heatmaster/server";\nexport type Y = X;\n',
          'import { x } from "@heatmaster/server";\nexport { x };\n',
        ]) {
          expect(await lint("packages/web/src/x.ts", code), code).toEqual(["heatmaster/boundary"]);
        }
      });
    });
  });
});
