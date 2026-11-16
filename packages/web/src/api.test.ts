import { describe, expect, it } from "vitest";
import { apiBase, createClient, eventsUrl } from "./api.ts";
import { apiError } from "../test/builders.ts";

type Call = Readonly<{ url: string; init: RequestInit | undefined }>;

function fakeFetch(answer: () => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: typeof input === "string" ? input : "?", init });
    return Promise.resolve(answer());
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("api", () => {
  describe("apiBase", () => {
    describe('With "/"', () => {
      it('returns "/api/"', () => {
        expect(apiBase("/")).toBe("/api/");
      });
    });
    describe('With "/api/hassio_ingress/TOKEN/"', () => {
      it('returns "/api/hassio_ingress/TOKEN/api/"', () => {
        expect(apiBase("/api/hassio_ingress/TOKEN/")).toBe("/api/hassio_ingress/TOKEN/api/");
      });
    });
    describe('With "/x/index.html"', () => {
      it('returns "/x/api/"', () => {
        expect(apiBase("/x/index.html")).toBe("/x/api/");
      });
    });
  });

  describe("eventsUrl", () => {
    describe('With "http://host:8080/"', () => {
      it('returns "ws://host:8080/api/events"', () => {
        expect(eventsUrl("http://host:8080/")).toBe("ws://host:8080/api/events");
      });
    });
    describe('With "https://ha.example/api/hassio_ingress/TOKEN/"', () => {
      it("returns the wss address under the same base", () => {
        expect(eventsUrl("https://ha.example/api/hassio_ingress/TOKEN/")).toBe(
          "wss://ha.example/api/hassio_ingress/TOKEN/api/events",
        );
      });
    });
  });

  describe("createClient", () => {
    describe("state / config", () => {
      it("sends GET to <base>state / <base>config and returns the body as ok", async () => {
        const { fetchFn, calls } = fakeFetch(() => json({ revision: 1 }));
        const client = createClient("/api/", fetchFn);
        const state = await client.state();
        const config = await client.config();
        expect(calls.map((c) => [c.url, c.init?.method])).toEqual([
          ["/api/state", "GET"],
          ["/api/config", "GET"],
        ]);
        expect(state).toEqual({ ok: true, value: { revision: 1 } });
        expect(config.ok).toBe(true);
      });
    });

    describe("preview / apply", () => {
      it("sends POST to <base>config/preview / <base>config with the request as JSON and the JSON content type", async () => {
        const { fetchFn, calls } = fakeFetch(() => json({}));
        const client = createClient("/api/", fetchFn);
        await client.preview({ yaml: "a: 1" });
        await client.apply({ yaml: "a: 1", expectedRevision: 2 });
        expect(calls.map((c) => [c.url, c.init?.method, c.init?.body])).toEqual([
          ["/api/config/preview", "POST", '{"yaml":"a: 1"}'],
          ["/api/config", "POST", '{"yaml":"a: 1","expectedRevision":2}'],
        ]);
        expect(calls[0]?.init?.headers).toEqual({ "Content-Type": "application/json" });
      });
    });

    describe("hold(true)", () => {
      it('sends POST to <base>hold with {"on":true}', async () => {
        const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 204 }));
        await createClient("/api/", fetchFn).hold(true);
        expect([calls[0]?.url, calls[0]?.init?.body]).toEqual(["/api/hold", '{"on":true}']);
      });
    });

    describe('refresh("z2m:0x00124b0012345678")', () => {
      it("sends POST to <base>valves/z2m%3A0x00124b0012345678/refresh with the body {}", async () => {
        const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 204 }));
        await createClient("/api/", fetchFn).refresh("z2m:0x00124b0012345678");
        expect([calls[0]?.url, calls[0]?.init?.method, calls[0]?.init?.body]).toEqual([
          "/api/valves/z2m%3A0x00124b0012345678/refresh",
          "POST",
          "{}",
        ]);
      });
    });

    describe("restore / forget / importOriginals(true)", () => {
      it('send POST to <base>valves/<id>/restore, <base>valves/<id>/forget, and <base>originals/import with {"acceptEmpty":true}', async () => {
        const { fetchFn, calls } = fakeFetch(() => new Response(null, { status: 204 }));
        const client = createClient("/api/", fetchFn);
        await client.restore("z2m:a");
        await client.forget("z2m:a");
        await client.importOriginals(true);
        expect(calls.map((c) => [c.url, c.init?.body])).toEqual([
          ["/api/valves/z2m%3Aa/restore", "{}"],
          ["/api/valves/z2m%3Aa/forget", "{}"],
          ["/api/originals/import", '{"acceptEmpty":true}'],
        ]);
      });
    });

    describe("With an answer 204", () => {
      it("returns ok with no value", async () => {
        const { fetchFn } = fakeFetch(() => new Response(null, { status: 204 }));
        expect(await createClient("/api/", fetchFn).hold(false)).toEqual({
          ok: true,
          value: undefined,
        });
      });
    });

    describe("With an answer 409 holding an ApiError", () => {
      it("returns not ok with status 409 and that error", async () => {
        const error = apiError("revision_conflict", { expected: "1", current: "2" });
        const { fetchFn } = fakeFetch(() => json(error, 409));
        expect(await createClient("/api/", fetchFn).apply({ yaml: "" })).toEqual({
          ok: false,
          status: 409,
          error,
        });
      });
    });

    describe("With an answer 502 holding HTML", () => {
      it("returns not ok with status 502 and code http_502", async () => {
        const { fetchFn } = fakeFetch(
          () => new Response("<html>Bad Gateway</html>", { status: 502 }),
        );
        expect(await createClient("/api/", fetchFn).state()).toEqual({
          ok: false,
          status: 502,
          error: { code: "http_502", message: "", data: {} },
        });
      });
    });

    describe("With fetch rejecting", () => {
      it("returns not ok with status 0 and code network", async () => {
        const fetchFn = (() => Promise.reject(new TypeError("down"))) as typeof fetch;
        expect(await createClient("/api/", fetchFn).state()).toEqual({
          ok: false,
          status: 0,
          error: { code: "network", message: "", data: {} },
        });
      });
    });

    describe("Always", () => {
      it("no method throws", async () => {
        const fetchFn = (() => {
          throw new Error("sync failure");
        }) as typeof fetch;
        const client = createClient("/api/", fetchFn);
        const results = await Promise.all([
          client.state(),
          client.config(),
          client.preview({}),
          client.apply({}),
          client.hold(true),
          client.refresh("a"),
          client.restore("a"),
          client.forget("a"),
          client.importOriginals(false),
        ]);
        expect(results.every((r) => !r.ok && r.error.code === "network")).toBe(true);
      });
    });
  });
});
