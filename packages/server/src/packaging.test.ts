import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import pkg from "../package.json" with { type: "json" };
import { DEFAULT_PORT } from "./options.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PACKAGING = path.join(ROOT, "packaging");
const APP = path.join(PACKAGING, "app");
const S6 = path.join(PACKAGING, "rootfs/etc/s6-overlay");
const SERVICES = ["server", "caddy"] as const;

const text = (file: string): string => readFileSync(file, "utf8");
const yaml = (file: string): Record<string, unknown> =>
  parse(text(file)) as Record<string, unknown>;
const firstLine = (file: string): string => text(file).split("\n")[0] ?? "";
const serviceDir = (name: string): string => path.join(S6, "s6-rc.d", name);

describe("packaging files", () => {
  describe("packaging/app/config.yaml", () => {
    const config = yaml(path.join(APP, "config.yaml"));

    describe("Always", () => {
      it("holds each key and value of the table above", () => {
        expect(config).toMatchObject({
          name: "Heatmaster",
          slug: "heatmaster",
          url: "https://github.com/t3hk0d3/heatmaster",
          image: "ghcr.io/t3hk0d3/heatmaster",
          arch: ["aarch64", "amd64"],
          init: false,
          ingress: true,
          ingress_port: 8099,
          panel_admin: true,
          panel_title: "Heatmaster",
          panel_icon: "mdi:radiator",
          services: ["mqtt:need"],
          homeassistant_api: true,
          map: [{ type: "app_config", read_only: false }],
          options: { z2m_base_topic: "zigbee2mqtt", discovery_prefix: "homeassistant" },
          schema: { z2m_base_topic: "str", discovery_prefix: "str" },
        });
        expect(typeof config.description).toBe("string");
      });

      it("is the only config.yaml, config.yml or config.json the Supervisor's app search can find", () => {
        const found = globSync("**/config.{yaml,yml,json}", { cwd: ROOT }).filter(
          (file) =>
            !file
              .split("/")
              .some((part) => part.startsWith(".") || part === "node_modules" || part === "rootfs"),
        );
        expect(found).toEqual(["packaging/app/config.yaml"]);
      });

      it("its version equals the server package's version", () => {
        expect(config.version).toBe(pkg.version);
      });

      it("has no ports key, no watchdog key and no language option", () => {
        expect(config).not.toHaveProperty("ports");
        expect(config).not.toHaveProperty("watchdog");
        expect(Object.keys(config.options as object).join()).not.toMatch(/lang/);
      });
    });
  });

  describe("repository.yaml", () => {
    describe("Always", () => {
      it("is at the repository root and has a name", () => {
        expect(yaml(path.join(ROOT, "repository.yaml")).name).toBe("Heatmaster");
      });
    });
  });

  describe("packaging/Caddyfile", () => {
    const caddyfile = text(path.join(PACKAGING, "Caddyfile"));

    describe("Always", () => {
      it("names 172.30.32.2 and port 8099, and proxies to 127.0.0.1 with the default port DEFAULT_PORT", () => {
        expect(caddyfile).toContain("172.30.32.2");
        expect(caddyfile).toContain(":8099");
        expect(caddyfile).toContain(`127.0.0.1:{$HEATMASTER_PORT:${String(DEFAULT_PORT)}}`);
      });

      it("does not hold basic_auth", () => {
        expect(caddyfile).not.toContain("basic_auth");
      });

      it("imports /run/heatmaster/caddy/*.caddy", () => {
        expect(caddyfile).toMatch(/^import \/run\/heatmaster\/caddy\/\*\.caddy$/m);
      });
    });
  });

  describe("packaging/password.caddy", () => {
    describe("Always", () => {
      it("listens on 8080 and holds basic_auth with UI_USER and UI_PASSWORD_HASH", () => {
        const file = text(path.join(PACKAGING, "password.caddy"));
        expect(file).toContain(":8080");
        expect(file).toContain("basic_auth");
        expect(file).toContain("{$UI_USER}");
        expect(file).toContain("{$UI_PASSWORD_HASH}");
      });
    });
  });

  describe("s6 services", () => {
    describe.each(SERVICES)("For %s", (name) => {
      it("type holds longrun, run is executable, and user/contents.d names the service", () => {
        expect(text(path.join(serviceDir(name), "type")).trim()).toBe("longrun");
        expect(statSync(path.join(serviceDir(name), "run")).mode & 0o111).not.toBe(0);
        expect(existsSync(path.join(S6, "user-bundles.d/user/contents.d", name))).toBe(true);
      });

      it("the first line of run names with-contenv", () => {
        expect(firstLine(path.join(serviceDir(name), "run"))).toMatch(/with-contenv/);
      });

      it("dependencies.d holds base", () => {
        expect(existsSync(path.join(serviceDir(name), "dependencies.d/base"))).toBe(true);
      });
    });

    describe("Always", () => {
      it("neither service lists the other under dependencies.d", () => {
        expect(existsSync(path.join(serviceDir("server"), "dependencies.d/caddy"))).toBe(false);
        expect(existsSync(path.join(serviceDir("caddy"), "dependencies.d/server"))).toBe(false);
      });

      it("the first line of server/finish names with-contenv", () => {
        expect(firstLine(path.join(serviceDir("server"), "finish"))).toMatch(/with-contenv/);
      });
    });
  });

  describe("translations", () => {
    describe("en.yaml and ru.yaml", () => {
      it("describe the same options as config.yaml's schema", () => {
        const schema = Object.keys(yaml(path.join(APP, "config.yaml")).schema as object).sort();
        for (const language of ["en", "ru"]) {
          const translation = yaml(path.join(APP, "translations", `${language}.yaml`));
          const described = Object.keys(translation.configuration ?? {}).sort();
          expect(described, language).toEqual(schema);
        }
      });
    });
  });
});
