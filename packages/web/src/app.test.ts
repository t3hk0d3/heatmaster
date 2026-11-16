import type { StateView } from "@heatmaster/core";
import { describe, expect, it, vi } from "vitest";
import type { ApiClient, Result } from "./api.ts";
import { mount } from "./app.ts";
import type { AppDeps } from "./app.ts";
import type { ConnectionStatus } from "./events.ts";
import { DICTIONARIES, LANGUAGE_KEY } from "./i18n.ts";
import {
  configView,
  fail,
  ok,
  planView,
  roomView,
  stateView,
  valveView,
} from "../test/builders.ts";

const en = DICTIONARIES.en;
const ru = DICTIONARIES.ru;
const ID = "z2m:0x00124b0012345678";

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

type Overrides = Partial<{
  [K in keyof ApiClient]: ReturnType<typeof vi.fn<ApiClient[K]>>;
}>;

function setup(
  options: Readonly<{
    client?: Overrides;
    confirm?: boolean;
    browser?: readonly string[];
    storage?: AppDeps["storage"];
    state?: StateView;
  }> = {},
) {
  const client = {
    state: vi.fn<ApiClient["state"]>(() => Promise.resolve(ok(options.state ?? stateView()))),
    config: vi.fn<ApiClient["config"]>(() => Promise.resolve(ok(configView()))),
    preview: vi.fn<ApiClient["preview"]>(() => Promise.resolve(ok(planView()))),
    apply: vi.fn<ApiClient["apply"]>(() => Promise.resolve(ok(planView({ revision: 4 })))),
    hold: vi.fn<ApiClient["hold"]>(() => Promise.resolve(ok(undefined))),
    refresh: vi.fn<ApiClient["refresh"]>(() => Promise.resolve(ok(undefined))),
    restore: vi.fn<ApiClient["restore"]>(() => Promise.resolve(ok(undefined))),
    forget: vi.fn<ApiClient["forget"]>(() => Promise.resolve(ok(undefined))),
    importOriginals: vi.fn<ApiClient["importOriginals"]>(() => Promise.resolve(ok(undefined))),
    ...options.client,
  } satisfies ApiClient;
  const closed = vi.fn();
  let handlers: Parameters<AppDeps["connect"]>[0] | undefined;
  const store = new Map<string, string>();
  const confirm = vi.fn(() => options.confirm ?? true);
  const root = document.createElement("div");
  const app = mount(root, {
    client,
    connect: (given) => {
      handlers = given;
      return { close: closed };
    },
    storage: options.storage ?? {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
    },
    browserLanguages: options.browser ?? ["en-US"],
    confirm,
  });
  return {
    client,
    root,
    app,
    store,
    confirm,
    closed,
    emit: (state: StateView) => {
      handlers?.onState(state);
    },
    status: (status: ConnectionStatus) => {
      handlers?.onStatus(status);
    },
    button: (action: string, valveId?: string): HTMLButtonElement => {
      const selector =
        valveId === undefined
          ? `button[data-action="${action}"]`
          : `button[data-action="${action}"][data-valve-id="${valveId}"]`;
      const found = root.querySelector<HTMLButtonElement>(selector);
      if (found === null) throw new Error(`no button ${selector}`);
      return found;
    },
    textarea: (): HTMLTextAreaElement => {
      const found = root.querySelector("textarea");
      if (found === null) throw new Error("no textarea");
      return found;
    },
    text: () => root.textContent,
  };
}

const roomState = (over: Partial<StateView> = {}): StateView =>
  stateView({
    rooms: [roomView({ name: "Living", valveIds: [ID] })],
    valves: [
      valveView({ valveId: ID, name: "Hall valve", roomId: "living", membership: "managed" }),
    ],
    ...over,
  });

describe("app", () => {
  describe("mount", () => {
    describe("At once", () => {
      it("reads the state and the config and shows them", async () => {
        const page = setup({ state: roomState() });
        await settle();
        expect(page.client.state).toHaveBeenCalledOnce();
        expect(page.client.config).toHaveBeenCalledOnce();
        expect(page.text()).toContain("Living");
        expect(page.textarea().value).toBe("version: 1\n");
      });
      it("opens the event stream", () => {
        const page = setup();
        page.emit(roomState());
        expect(page.text()).toContain("Living");
      });
    });

    describe("With a state message", () => {
      it("the rooms, the problems and the header show the new state", async () => {
        const page = setup();
        await settle();
        page.emit(
          roomState({
            held: true,
            revision: 3,
            problems: [
              {
                kind: "valve_silent",
                subject: { kind: "valve", id: ID },
                severity: "error",
                name: "Hall valve",
                data: {},
              },
            ],
          }),
        );
        expect(page.text()).toContain("Living");
        expect(page.text()).toContain("Valve Hall valve is not responding");
        expect(page.text()).toContain(en["header.held"]);
      });
      it("the editor's text area is the same element with the same text", async () => {
        const page = setup();
        await settle();
        const area = page.textarea();
        area.value = "typed by the user";
        area.dispatchEvent(new Event("input", { bubbles: true }));
        page.emit(roomState());
        expect(page.textarea()).toBe(area);
        expect(area.value).toBe("typed by the user");
      });
    });

    describe("With the config refused as config_unreadable", () => {
      it("the editor is empty and the error is shown", async () => {
        const page = setup({
          client: { config: vi.fn(() => Promise.resolve(fail("config_unreadable"))) },
        });
        await settle();
        expect(page.textarea().value).toBe("");
        expect(page.text()).toContain(en["error.config_unreadable"]);
      });
    });
  });

  describe("stop writing", () => {
    describe("When pressed", () => {
      it("hold(true) is called without a question", async () => {
        const page = setup();
        await settle();
        page.emit(stateView({ held: false }));
        page.button("hold").click();
        expect(page.client.hold).toHaveBeenCalledWith(true);
        expect(page.confirm).not.toHaveBeenCalled();
      });
    });
  });

  describe("release writes", () => {
    describe("When pressed and confirmed", () => {
      it("hold(false) is called", async () => {
        const page = setup({ confirm: true });
        await settle();
        page.emit(stateView({ held: true }));
        page.button("release").click();
        expect(page.confirm).toHaveBeenCalledOnce();
        expect(page.client.hold).toHaveBeenCalledWith(false);
      });
    });
    describe("When pressed and not confirmed", () => {
      it("nothing is called", async () => {
        const page = setup({ confirm: false });
        await settle();
        page.emit(stateView({ held: true }));
        page.button("release").click();
        await settle();
        expect(page.client.hold).not.toHaveBeenCalled();
      });
    });
  });

  describe("after a hold call", () => {
    describe("With a clean editor", () => {
      it("the config is read again", async () => {
        const page = setup();
        await settle();
        page.emit(stateView());
        page.button("hold").click();
        await settle();
        expect(page.client.config).toHaveBeenCalledTimes(2);
      });
    });
    describe("With a dirty editor", () => {
      it('the text is kept and the "changed on the server" notice is shown', async () => {
        const page = setup();
        await settle();
        page.emit(stateView());
        page.textarea().value = "mine";
        page.textarea().dispatchEvent(new Event("input", { bubbles: true }));
        page.button("hold").click();
        await settle();
        expect(page.client.config).toHaveBeenCalledOnce();
        expect(page.textarea().value).toBe("mine");
        expect(page.text()).toContain(en["editor.server_changed"]);
      });
    });
  });

  describe("a config read that lands after the user typed", () => {
    describe("With the editor edited while the read was in flight", () => {
      it('the text is kept and the "changed on the server" notice is shown', async () => {
        let land: ((result: Result<ReturnType<typeof configView>>) => void) | undefined;
        const pending = new Promise<Result<ReturnType<typeof configView>>>((resolve) => {
          land = resolve;
        });
        const page = setup({ client: { config: vi.fn(() => pending) } });
        await settle();
        page.textarea().value = "mine";
        page.textarea().dispatchEvent(new Event("input", { bubbles: true }));
        land?.(ok(configView({ yaml: "theirs: 1\n" })));
        await settle();
        expect(page.textarea().value).toBe("mine");
        expect(page.text()).toContain(en["editor.server_changed"]);
      });
    });
  });

  describe("preview and apply", () => {
    async function typed() {
      const page = setup();
      await settle();
      page.emit(stateView());
      page.textarea().value = "version: 1\nrooms: []\n";
      page.textarea().dispatchEvent(new Event("input", { bubbles: true }));
      return page;
    }

    describe("When Preview is pressed", () => {
      it("preview is called with request(editor) and the plan is shown", async () => {
        const page = await typed();
        page.button("preview").click();
        await settle();
        expect(page.client.preview).toHaveBeenCalledWith({
          yaml: "version: 1\nrooms: []\n",
          expectedRevision: 3,
          acceptUnknownOriginals: [],
          overwriteUnreadable: false,
        });
        expect(page.text()).toContain(en["plan.title"]);
      });
    });

    describe("When Apply is pressed after it", () => {
      it("apply is called with an equal request", async () => {
        const page = await typed();
        page.button("preview").click();
        await settle();
        page.button("apply").click();
        await settle();
        expect(page.client.apply).toHaveBeenCalledWith(page.client.preview.mock.calls[0]?.[0]);
      });
      it("the page says which revision was applied", async () => {
        const page = await typed();
        page.button("preview").click();
        await settle();
        page.button("apply").click();
        await settle();
        expect(page.text()).toContain("Applied as revision 4.");
      });
    });

    describe("With apply refused as revision_conflict", () => {
      it("the error is shown and the text is kept", async () => {
        const page = await typed();
        page.client.apply.mockResolvedValueOnce(
          fail("revision_conflict", { expected: "3", current: "5" }),
        );
        page.button("preview").click();
        await settle();
        page.button("apply").click();
        await settle();
        expect(page.text()).toContain("the server has revision 5");
        expect(page.textarea().value).toBe("version: 1\nrooms: []\n");
      });
    });

    describe("With preview refused as valve_not_observed", () => {
      it('the "asked to report, try again" text is shown', async () => {
        const page = await typed();
        page.client.preview.mockResolvedValueOnce(fail("valve_not_observed", { valveIds: ID }));
        page.button("preview").click();
        await settle();
        expect(page.text()).toContain("They were asked to report; try again shortly.");
      });
    });

    describe("With preview refused as timezone_missing", () => {
      it("the text that tells the user to set the time zone is shown", async () => {
        const page = await typed();
        page.client.preview.mockResolvedValueOnce(fail("timezone_missing"));
        page.button("preview").click();
        await settle();
        expect(page.text()).toContain("Set timezone in the settings");
      });
    });
  });

  describe("valve actions", () => {
    describe("When refresh is pressed for a valve", () => {
      it("refresh is called with its id", async () => {
        const page = setup();
        await settle();
        page.emit(roomState());
        page.button("refresh", ID).click();
        expect(page.client.refresh).toHaveBeenCalledWith(ID);
      });
    });
    describe("When forget is pressed and not confirmed", () => {
      it("nothing is called", async () => {
        const page = setup({ confirm: false });
        await settle();
        page.emit(stateView({ valves: [valveView({ valveId: ID, membership: "orphan" })] }));
        page.button("forget", ID).click();
        await settle();
        expect(page.confirm).toHaveBeenCalledOnce();
        expect(page.client.forget).not.toHaveBeenCalled();
      });
    });
    describe("With an action refused", () => {
      it("the error is shown", async () => {
        const page = setup({
          client: { restore: vi.fn(() => Promise.resolve(fail("valve_managed", { valveId: ID }))) },
        });
        await settle();
        page.emit(stateView({ valves: [valveView({ valveId: ID, membership: "orphan" })] }));
        page.button("restore", ID).click();
        await settle();
        expect(page.text()).toContain("is in a room");
      });
    });
    describe("With refresh refused as ask_limited", () => {
      it('the "asked a moment ago" text is shown', async () => {
        const page = setup({
          client: { refresh: vi.fn(() => Promise.resolve(fail("ask_limited", { valveId: ID }))) },
        });
        await settle();
        page.emit(roomState());
        page.button("refresh", ID).click();
        await settle();
        expect(page.text()).toContain("was asked a moment ago");
      });
    });
    describe("While a request is running", () => {
      it("the action buttons are disabled", async () => {
        let finish: (result: Result<void>) => void = () => undefined;
        const page = setup({
          client: {
            refresh: vi.fn(
              () =>
                new Promise<Result<void>>((resolve) => {
                  finish = resolve;
                }),
            ),
          },
        });
        await settle();
        page.emit(roomState());
        page.button("refresh", ID).click();
        const actions = [...page.root.querySelectorAll<HTMLButtonElement>("button")].filter(
          (b) => b.dataset.action !== "language",
        );
        expect(actions.length).toBeGreaterThan(0);
        expect(actions.every((b) => b.disabled)).toBe(true);
        finish(ok(undefined));
        await settle();
        expect(page.button("refresh", ID).disabled).toBe(false);
      });
    });
  });

  describe("import of originals", () => {
    const broken = () => stateView({ ledgerReadable: false, originalsCopyRecords: 2 });
    describe("When pressed", () => {
      it("importOriginals(false) is called", async () => {
        const page = setup();
        await settle();
        page.emit(broken());
        page.button("import").click();
        expect(page.client.importOriginals).toHaveBeenCalledWith(false);
      });
    });
    describe("With that refused as no_originals_copy", () => {
      it("a button to start with an empty record appears", async () => {
        const page = setup({
          client: { importOriginals: vi.fn(() => Promise.resolve(fail("no_originals_copy"))) },
        });
        await settle();
        page.emit(broken());
        page.button("import").click();
        await settle();
        expect(page.button("import-empty")).toBeTruthy();
      });
    });
    describe("When that button is pressed and confirmed", () => {
      it("importOriginals(true) is called", async () => {
        const importOriginals = vi
          .fn<ApiClient["importOriginals"]>()
          .mockResolvedValueOnce(fail("no_originals_copy"))
          .mockResolvedValue(ok(undefined));
        const page = setup({ client: { importOriginals }, confirm: true });
        await settle();
        page.emit(broken());
        page.button("import").click();
        await settle();
        page.button("import-empty").click();
        expect(page.confirm).toHaveBeenCalledOnce();
        expect(importOriginals).toHaveBeenLastCalledWith(true);
      });
    });
  });

  describe("language", () => {
    describe("With nothing stored and a Russian browser", () => {
      it("the page is in Russian", async () => {
        const page = setup({ browser: ["ru-RU"] });
        await settle();
        expect(page.text()).toContain(ru["editor.title"]);
        expect(page.root.ownerDocument.documentElement.lang).toBe("ru");
      });
    });
    describe("When switched to English", () => {
      it('the page is redrawn in English, the choice is stored and the page\'s lang is "en"', async () => {
        const page = setup({ browser: ["ru"] });
        await settle();
        page.root.querySelector<HTMLButtonElement>('button[data-language="en"]')?.click();
        expect(page.text()).toContain(en["editor.title"]);
        expect(page.store.get(LANGUAGE_KEY)).toBe("en");
        expect(page.root.ownerDocument.documentElement.lang).toBe("en");
      });
    });
    describe("With a storage that throws", () => {
      it("the page still switches", async () => {
        const page = setup({
          browser: ["ru"],
          storage: {
            getItem: () => {
              throw new Error("blocked");
            },
            setItem: () => {
              throw new Error("blocked");
            },
          },
        });
        await settle();
        page.root.querySelector<HTMLButtonElement>('button[data-language="en"]')?.click();
        expect(page.text()).toContain(en["editor.title"]);
      });
    });
  });

  describe("start-up errors", () => {
    describe("With the first state read refused and then a state message", () => {
      it("the error is no longer shown", async () => {
        const page = setup({
          client: { state: vi.fn(() => Promise.resolve(fail("not_ready"))) },
        });
        await settle();
        expect(page.text()).toContain(en["error.not_ready"]);
        page.emit(stateView());
        expect(page.text()).not.toContain(en["error.not_ready"]);
      });
    });
    describe("With a refused user action and then a state message", () => {
      it("the action's error stays", async () => {
        const page = setup({
          client: { refresh: vi.fn(() => Promise.resolve(fail("ask_limited", { valveId: ID }))) },
        });
        await settle();
        page.emit(roomState());
        page.button("refresh", ID).click();
        await settle();
        page.emit(roomState());
        expect(page.text()).toContain("was asked a moment ago");
      });
    });
    describe("With the first config read refused as not_ready and then a state message", () => {
      it("the config is read again", async () => {
        const config = vi
          .fn<ApiClient["config"]>()
          .mockResolvedValueOnce(fail("not_ready"))
          .mockResolvedValue(ok(configView({ yaml: "later: 1\n" })));
        const page = setup({ client: { config } });
        await settle();
        page.emit(stateView());
        await settle();
        expect(page.textarea().value).toBe("later: 1\n");
      });
    });
  });

  describe("confirmed paths", () => {
    describe("When forget is pressed and confirmed", () => {
      it("forget is called with the id", async () => {
        const page = setup({ confirm: true });
        await settle();
        page.emit(stateView({ valves: [valveView({ valveId: ID, membership: "orphan" })] }));
        page.button("forget", ID).click();
        expect(page.client.forget).toHaveBeenCalledWith(ID);
      });
    });
    describe("When release is pressed and not confirmed", () => {
      it("the config is not read again", async () => {
        const page = setup({ confirm: false });
        await settle();
        page.emit(stateView({ held: true }));
        page.button("release").click();
        await settle();
        expect(page.client.config).toHaveBeenCalledOnce();
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("the event stream is closed", () => {
        const page = setup();
        page.app.stop();
        expect(page.closed).toHaveBeenCalledOnce();
      });
    });
  });
});
