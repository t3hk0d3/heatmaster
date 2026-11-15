import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const WEB_DIR = path.resolve(import.meta.dirname, "..");

describe("web package", () => {
  describe("vite build", () => {
    describe("On the scaffold page", () => {
      let out = "";
      let html = "";

      beforeAll(async () => {
        out = mkdtempSync(path.join(tmpdir(), "heatmaster-web-"));
        await build({
          root: WEB_DIR,
          logLevel: "silent",
          build: { outDir: out, emptyOutDir: true },
        });
        html = readFileSync(path.join(out, "index.html"), "utf8");
      });

      afterAll(() => {
        rmSync(out, { recursive: true, force: true });
      });

      it("writes index.html into the output folder", () => {
        expect(html).toContain("<title>Heatmaster</title>");
      });

      it('every script and stylesheet address in it starts with "./"', () => {
        const addresses = [
          ...html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)="([^"]*)"/g),
        ].map((match) => match[1] ?? "");
        expect(addresses.length).toBeGreaterThan(0);
        for (const address of addresses) expect(address.startsWith("./"), address).toBe(true);
      });
    });
  });
});
