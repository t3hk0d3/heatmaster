import type { StateView } from "@heatmaster/core";
import { describe, expect, it } from "vitest";
import { edited, loaded, previewed, refused, request } from "./editor.ts";
import { DICTIONARIES, translator } from "./i18n.ts";
import {
  formatTemperature,
  renderEditorControls,
  renderError,
  renderHeader,
  renderOtherValves,
  renderPlan,
  renderProblems,
  renderRooms,
  valveActions,
} from "./render.ts";
import {
  apiError,
  configView,
  planView,
  problemView,
  roomView,
  stateView,
  valveView,
} from "../test/builders.ts";

const t = translator("en");
const en = DICTIONARIES.en;
const ID = "z2m:0x00124b0012345678";

function text(element: HTMLElement): string {
  return element.textContent;
}
function button(element: HTMLElement, action: string): HTMLButtonElement | null {
  return element.querySelector(`button[data-action="${action}"]`);
}

describe("render", () => {
  describe("formatTemperature", () => {
    describe("With 19.6 in en / ru", () => {
      it('returns "19.6 °C" / "19,6 °C"', () => {
        expect(formatTemperature(19.6, "en")).toBe("19.6 °C");
        expect(formatTemperature(19.6, "ru")).toBe("19,6 °C");
      });
    });
    describe("With 20 in en", () => {
      it('returns "20.0 °C"', () => {
        expect(formatTemperature(20, "en")).toBe("20.0 °C");
      });
    });
    describe("With undefined", () => {
      it('returns the "unknown" text', () => {
        expect(formatTemperature(undefined, "en")).toBe(en.unknown);
      });
    });
  });

  describe("valveActions", () => {
    describe("For a supported valve in a room", () => {
      it("returns refresh only", () => {
        expect(valveActions(valveView({ roomId: "r", membership: "managed" }))).toEqual([
          "refresh",
        ]);
      });
    });
    describe("For an orphan", () => {
      it("returns refresh, restore and forget", () => {
        expect(valveActions(valveView({ membership: "orphan" }))).toEqual([
          "refresh",
          "restore",
          "forget",
        ]);
      });
    });
    describe("For a releasing valve", () => {
      it("returns refresh and forget", () => {
        expect(valveActions(valveView({ membership: "releasing" }))).toEqual(["refresh", "forget"]);
      });
    });
    describe("For an unsupported valve that is in a room", () => {
      it("returns nothing", () => {
        expect(
          valveActions(valveView({ supported: false, roomId: "r", membership: "managed" })),
        ).toEqual([]);
      });
    });
  });

  describe("renderHeader", () => {
    describe("With no state yet", () => {
      it("shows the connection status and no hold button", () => {
        const header = renderHeader(undefined, "connecting", "en", t);
        expect(text(header)).toContain(en["header.status.connecting"]);
        expect(button(header, "hold")).toBeNull();
        expect(button(header, "release")).toBeNull();
      });
    });
    describe("With writes held", () => {
      it('shows the "held" text and the release button, and no stop button', () => {
        const header = renderHeader(stateView({ held: true }), "live", "en", t);
        expect(text(header)).toContain(en["header.held"]);
        expect(button(header, "release")).not.toBeNull();
        expect(button(header, "hold")).toBeNull();
      });
    });
    describe("With writes not held", () => {
      it("shows the stop button and no release button", () => {
        const header = renderHeader(stateView({ held: false }), "live", "en", t);
        expect(button(header, "hold")).not.toBeNull();
        expect(button(header, "release")).toBeNull();
      });
    });
    describe("With links { z2m: true, ha: false }", () => {
      it("shows Zigbee2MQTT as up and Home Assistant as down, in words", () => {
        const header = renderHeader(
          stateView({ links: { z2m: true, ha: false } }),
          "live",
          "en",
          t,
        );
        expect(text(header)).toContain("Zigbee2MQTT: up");
        expect(text(header)).toContain("Home Assistant: down");
      });
    });
    describe('With transportFaults { z2m: "mqtt_auth_failed" }', () => {
      it("shows the translated reason beside Zigbee2MQTT", () => {
        const header = renderHeader(
          stateView({ transportFaults: { z2m: "mqtt_auth_failed" } }),
          "live",
          "en",
          t,
        );
        expect(text(header)).toContain(en["reason.mqtt_auth_failed"]);
      });
    });
    describe("With no ha link", () => {
      it("shows no Home Assistant entry", () => {
        expect(text(renderHeader(stateView(), "live", "en", t))).not.toContain("Home Assistant");
      });
    });
    describe('With status "lost"', () => {
      it("says that the connection to Heatmaster is lost", () => {
        expect(text(renderHeader(stateView(), "lost", "en", t))).toContain(
          en["header.status.lost"],
        );
      });
    });
  });

  describe("renderRooms", () => {
    const room = roomView({
      name: "Living",
      currentTemperature: 19.6,
      target: 21,
      sync: "pending",
      valveIds: [ID],
    });
    const full = (): StateView =>
      stateView({
        rooms: [room],
        valves: [
          valveView({
            valveId: ID,
            name: "Hall valve",
            roomId: "living",
            membership: "managed",
            liveness: "live",
            sync: "in_sync",
            battery: 87,
          }),
        ],
      });

    describe("With one room and one valve", () => {
      it("shows the room's name, temperature, target and sync text", () => {
        const out = text(renderRooms(full(), "en", t));
        expect(out).toContain("Living");
        expect(out).toContain("19.6 °C");
        expect(out).toContain("21.0 °C");
        expect(out).toContain(en["sync.pending"]);
      });
      it("shows the valve's name, id, membership, liveness, sync and battery", () => {
        const out = text(renderRooms(full(), "en", t));
        for (const part of [
          "Hall valve",
          ID,
          en["membership.managed"],
          en["liveness.live"],
          en["sync.in_sync"],
          "87",
        ]) {
          expect(out).toContain(part);
        }
      });
      it("the valve has a refresh button carrying its id", () => {
        expect(button(renderRooms(full(), "en", t), "refresh")?.dataset.valveId).toBe(ID);
      });
    });
    describe("With an unknown temperature", () => {
      it("shows the unknown text", () => {
        const state = stateView({ rooms: [roomView()] });
        expect(text(renderRooms(state, "en", t))).toContain(en.unknown);
      });
    });
    describe("With a degraded room", () => {
      it("says so in words", () => {
        const state = stateView({ rooms: [roomView({ degraded: true })] });
        expect(text(renderRooms(state, "en", t))).toContain(en["rooms.degraded"]);
      });
    });
    describe("With a diverged room", () => {
      it("says so in words", () => {
        const state = stateView({ rooms: [roomView({ diverged: true })] });
        expect(text(renderRooms(state, "en", t))).toContain(en["rooms.diverged"]);
      });
    });
    describe("With a room named <b>x</b>", () => {
      it("the page shows those characters and holds no b element", () => {
        const state = stateView({ rooms: [roomView({ name: "<b>x</b>" })] });
        const out = renderRooms(state, "en", t);
        expect(text(out)).toContain("<b>x</b>");
        expect(out.querySelector("b")).toBeNull();
      });
    });
    describe("With no rooms", () => {
      it('shows the "no rooms" text', () => {
        expect(text(renderRooms(stateView(), "en", t))).toContain(en["rooms.none"]);
      });
    });
  });

  describe("renderOtherValves", () => {
    describe("With a supported valve in no room", () => {
      it("shows its name and its id", () => {
        const state = stateView({ valves: [valveView({ valveId: ID, name: "Spare" })] });
        const out = text(renderOtherValves(state, t));
        expect(out).toContain("Spare");
        expect(out).toContain(ID);
      });
    });
    describe("With an unassigned valve whose observed is false", () => {
      it("says in words that the valve has not reported yet", () => {
        const state = stateView({
          valves: [valveView({ valveId: ID })],
          unassigned: [
            { valveId: ID, name: "Spare", observed: false, liveness: "unknown", values: {} },
          ],
        });
        expect(text(renderOtherValves(state, t))).toContain(en["others.not_reported"]);
      });
    });
    describe("With an unassigned valve whose observed is true", () => {
      it('shows its liveness and the values it reported, and no "not reported" text', () => {
        const state = stateView({
          valves: [valveView({ valveId: ID })],
          unassigned: [
            {
              valveId: ID,
              name: "Spare",
              observed: true,
              liveness: "live",
              values: { day_mon: ["06:30/20", "22:00/17"], sensor_source: "internal" },
            },
          ],
        });
        const out = text(renderOtherValves(state, t));
        expect(out).toContain(en["liveness.live"]);
        expect(out).toContain("06:30/20, 22:00/17");
        expect(out).toContain("internal");
        expect(out).not.toContain(en["others.not_reported"]);
      });
      it("shows no day readback of a TRV-ZBT, whose days are write-only", () => {
        const state = stateView({
          valves: [valveView({ valveId: ID, modelId: "TRV-ZBT" })],
          unassigned: [
            {
              valveId: ID,
              name: "Spare",
              observed: true,
              liveness: "live",
              values: { day_mon: ["06:30/20"], active_group: 3 },
            },
          ],
        });
        const out = text(renderOtherValves(state, t));
        expect(out).not.toContain("06:30/20");
        expect(out).toContain(en["setting.active_group"]);
      });
    });
    describe("With an orphan", () => {
      it("shows restore and forget buttons carrying its id", () => {
        const state = stateView({ valves: [valveView({ valveId: ID, membership: "orphan" })] });
        const out = renderOtherValves(state, t);
        expect(button(out, "restore")?.dataset.valveId).toBe(ID);
        expect(button(out, "forget")?.dataset.valveId).toBe(ID);
      });
    });
  });

  describe("renderProblems", () => {
    describe("With no problems", () => {
      it('shows the "no problems" text', () => {
        expect(text(renderProblems(stateView(), t))).toContain(en["problems.none"]);
      });
    });
    describe("With a silent valve named Hall", () => {
      it('shows the valve_silent text with "Hall" and the severity', () => {
        const out = text(renderProblems(stateView({ problems: [problemView()] }), t));
        expect(out).toContain("Valve Hall is not responding");
        expect(out).toContain(en["severity.error"]);
      });
    });
    describe("With setting_not_holding for the group sensor_source", () => {
      it("the text holds the group's translated name", () => {
        const problem = problemView({
          kind: "setting_not_holding",
          data: { setting: "sensor_source" },
        });
        expect(text(renderProblems(stateView({ problems: [problem] }), t))).toContain(
          `its ${en["group.sensor_source"]}`,
        );
      });
    });
    describe("With transport_unusable and the reason another_instance", () => {
      it("the text holds the translated reason", () => {
        const problem = problemView({
          kind: "transport_unusable",
          subject: { kind: "system", id: "z2m" },
          name: "z2m",
          data: { transport: "z2m", reason: "another_instance" },
        });
        const out = text(renderProblems(stateView({ problems: [problem] }), t));
        expect(out).toContain(en["reason.another_instance"]);
        expect(out).toContain(en["link.z2m"]);
      });
    });
    describe("With link_down for ha", () => {
      it("the text names Home Assistant", () => {
        const problem = problemView({
          kind: "link_down",
          subject: { kind: "system", id: "ha" },
          name: "ha",
          data: { link: "ha" },
        });
        expect(text(renderProblems(stateView({ problems: [problem] }), t))).toContain(
          "The connection to Home Assistant is down",
        );
      });
    });
    describe("With ledgerReadable false", () => {
      const state = stateView({ ledgerReadable: false, originalsCopyRecords: 3 });
      it("shows the import button", () => {
        expect(button(renderProblems(state, t), "import")).not.toBeNull();
      });
      it("says how many records the saved copy holds", () => {
        expect(text(renderProblems(state, t))).toContain("holds 3 records");
      });
    });
    describe('With ledgerReadable false, configState "empty" and originalsCopyRecords 3', () => {
      it("shows the originals.found text with the number 3", () => {
        const state = stateView({
          ledgerReadable: false,
          configState: "empty",
          originalsCopyRecords: 3,
        });
        expect(text(renderProblems(state, t))).toContain("original settings of 3 valves");
      });
    });
    describe('With ledgerReadable false and configState "ok"', () => {
      it("shows no originals.found text", () => {
        const state = stateView({
          ledgerReadable: false,
          configState: "ok",
          originalsCopyRecords: 3,
        });
        expect(text(renderProblems(state, t))).not.toContain("original settings of 3 valves");
      });
    });
    describe("With valve_not_auto for a valve in heat", () => {
      it("the text holds the valve's name and the translated mode", () => {
        const problem = problemView({
          kind: "valve_not_auto",
          name: "Hall",
          data: { mode: "heat" },
        });
        const out = text(renderProblems(stateView({ problems: [problem] }), t));
        expect(out).toContain("Valve Hall is in heat mode");
      });
    });
    describe("With store_write_failed for the ledger", () => {
      it("the text holds the translated store name", () => {
        const problem = problemView({
          kind: "store_write_failed",
          subject: { kind: "system", id: "system" },
          name: "system",
          data: { store: "ledger" },
        });
        expect(text(renderProblems(stateView({ problems: [problem] }), t))).toContain(
          en["store.ledger"],
        );
      });
    });
    describe("With ledgerReadable true", () => {
      it("shows no import button", () => {
        expect(button(renderProblems(stateView(), t), "import")).toBeNull();
      });
    });
    describe("With the empty-record offer", () => {
      it("shows a second button to start with an empty record", () => {
        const state = stateView({ ledgerReadable: false });
        expect(button(renderProblems(state, t, true), "import-empty")).not.toBeNull();
        expect(button(renderProblems(state, t), "import-empty")).toBeNull();
      });
    });
  });

  describe("renderPlan", () => {
    describe("With a joining valve and one original with evidence acked", () => {
      it("shows the valve's name, the setting's name, its value and the evidence text", () => {
        const plan = planView({
          joining: [
            {
              valveId: ID,
              name: "Hall valve",
              originals: [{ setting: "sensor_source", value: "internal", evidence: "acked" }],
              unreadable: [],
            },
          ],
        });
        const out = text(renderPlan(plan, t, []));
        for (const part of [
          "Hall valve",
          en["setting.sensor_source"],
          "internal",
          en["evidence.acked"],
        ]) {
          expect(out).toContain(part);
        }
      });
    });
    describe("With an original that could not be read", () => {
      it("says so for that setting", () => {
        const plan = planView({
          joining: [
            {
              valveId: ID,
              name: "Hall valve",
              originals: [{ setting: "active_group", value: null, evidence: "none" }],
              unreadable: ["active_group"],
            },
          ],
        });
        expect(text(renderPlan(plan, t, []))).toContain(
          `${en["setting.active_group"]}: could not be read`,
        );
      });
    });
    describe('With a write that has "from" and one that has none', () => {
      it("shows from → to for the first and the unknown text → to for the second", () => {
        const plan = planView({
          writes: [
            {
              valveId: ID,
              name: "Hall valve",
              settings: [
                { setting: "sensor_source", from: "internal", to: "external" },
                { setting: "active_group", to: 3 },
              ],
            },
          ],
        });
        const out = text(renderPlan(plan, t, []));
        expect(out).toContain(`${en["setting.sensor_source"]}: internal → external`);
        expect(out).toContain(`${en["setting.active_group"]}: ${en.unknown} → 3`);
      });
      it("does not show the readback of TRV-ZBT days as the valve's schedule", () => {
        const plan = planView({
          writes: [
            {
              valveId: ID,
              name: "Window",
              settings: [{ setting: "day_mon", from: ["06:30/19"], to: ["06:30/20"] }],
            },
          ],
        });
        const out = text(renderPlan(plan, t, [valveView({ valveId: ID, modelId: "TRV-ZBT" })]));
        expect(out).not.toContain("06:30/19");
        expect(out).toContain("06:30/20");
      });
    });
    describe("With no writes", () => {
      it('shows the "nothing will be written" text', () => {
        expect(text(renderPlan(planView(), t, []))).toContain(en["plan.nothing"]);
      });
    });
    describe("With held true / false", () => {
      it("says that writes stay held / that Heatmaster will write to the valves", () => {
        expect(text(renderPlan(planView({ held: true }), t, []))).toContain(en["plan.held"]);
        expect(text(renderPlan(planView({ held: false }), t, []))).toContain(en["plan.not_held"]);
      });
    });
    describe("With a plan", () => {
      it("no rejoining or leaving list is shown", () => {
        const plan = planView({
          pending: [
            {
              valveId: "z2m:a",
              name: "Waiting valve",
              roomId: "office",
              reason: "valve_not_observed",
              unreadable: [],
            },
          ],
        });
        const headings = [...renderPlan(plan, t, []).querySelectorAll("h4")].map(
          (heading) => heading.textContent,
        );
        expect(headings).toEqual([en["plan.writes"]]);
      });
    });
  });

  describe("renderError", () => {
    describe("With a known code", () => {
      it("shows the dictionary text with the error's data put in", () => {
        const error = apiError("revision_conflict", { expected: "3", current: "4" });
        expect(text(renderError(error, t))).toContain(
          "you edited revision 3, the server has revision 4",
        );
      });
    });
    describe("With a code http_<n>", () => {
      it("shows error.http with the status", () => {
        const error = { code: "http_502", message: "", data: {} };
        expect(text(renderError(error, t))).toContain("status 502");
      });
    });
    describe("With config_invalid and three issues", () => {
      it("shows three lines, each with the path, the code and the message", () => {
        const issues = [
          { path: "rooms.0.id", code: "required", message: "id is required" },
          { path: "rooms.1.name", code: "type", message: "name must be text" },
          { path: "settings.timezone", code: "invalid", message: "unknown zone" },
        ];
        const out = renderError(apiError("config_invalid", { issues }), t);
        const lines = [...out.querySelectorAll("li")].map((li) => li.textContent);
        expect(lines).toEqual([
          "rooms.0.id: required — id is required",
          "rooms.1.name: type — name must be text",
          "settings.timezone: invalid — unknown zone",
        ]);
      });
    });
    describe("With a code that has no text", () => {
      it("shows the server's message", () => {
        expect(text(renderError(apiError("brand_new_code"), t))).toContain(
          "server says brand_new_code",
        );
      });
    });
  });

  describe("renderEditorControls", () => {
    const clean = () => loaded(configView());
    const ready = () => {
      const state = edited(clean(), "x");
      return previewed(state, request(state), planView());
    };
    describe("With canApply false", () => {
      it("the Apply button is disabled", () => {
        expect(button(renderEditorControls(clean(), undefined, false, t), "apply")?.disabled).toBe(
          true,
        );
        expect(button(renderEditorControls(ready(), undefined, false, t), "apply")?.disabled).toBe(
          false,
        );
      });
    });
    describe("While busy", () => {
      it("Preview and Apply are disabled", () => {
        const out = renderEditorControls(ready(), undefined, true, t);
        expect(button(out, "preview")?.disabled).toBe(true);
        expect(button(out, "apply")?.disabled).toBe(true);
      });
    });
    describe('With configState "unreadable"', () => {
      it("shows the overwrite switch", () => {
        const out = renderEditorControls(
          clean(),
          stateView({ configState: "unreadable" }),
          false,
          t,
        );
        expect(out.querySelector('input[data-action="overwrite"]')).not.toBeNull();
      });
    });
    describe('With configState "ok"', () => {
      it("shows no overwrite switch", () => {
        const out = renderEditorControls(clean(), stateView(), false, t);
        expect(out.querySelector('input[data-action="overwrite"]')).toBeNull();
      });
    });
    describe("With a plan holding pending valves", () => {
      it("no accept checkbox is shown", () => {
        const plan = planView({
          pending: [
            {
              valveId: ID,
              name: "Hall valve",
              roomId: "hall",
              reason: "originals_unreadable",
              unreadable: ["sensor_source"],
            },
          ],
        });
        const editor = previewed(clean(), request(clean()), plan);
        const state = stateView({ valves: [valveView({ valveId: ID, name: "Hall valve" })] });
        const out = renderEditorControls(editor, state, false, t);
        expect(out.querySelectorAll('input[data-action="accept"]')).toHaveLength(0);
        expect(out.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
        // Nor after a refusal that names a valve, as plan 1's flow offered one.
        const named = refused(clean(), apiError("originals_unreadable", { valveId: ID }));
        const after = renderEditorControls(named, state, false, t);
        expect(after.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
      });
    });
    describe("With serverChanged", () => {
      it("shows the notice and the Reload button", () => {
        const editor = { ...clean(), serverChanged: true };
        const out = renderEditorControls(editor, undefined, false, t);
        expect(text(out)).toContain(en["editor.server_changed"]);
        expect(button(out, "reload")).not.toBeNull();
      });
    });
    describe("With dirty and appliedRevision", () => {
      it("shows the notices", () => {
        expect(text(renderEditorControls(edited(clean(), "y"), undefined, false, t))).toContain(
          en["editor.dirty"],
        );
        const applied = { ...clean(), appliedRevision: 5 };
        expect(text(renderEditorControls(applied, undefined, false, t))).toContain("revision 5");
      });
    });
  });
});
