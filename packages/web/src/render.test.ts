import type { PendingReason, RoomView, SettingKey, StateView } from "@heatmaster/core";
import { describe, expect, it } from "vitest";
import { edited, loaded, previewed, refused, request } from "./editor.ts";
import { DICTIONARIES, translator } from "./i18n.ts";
import {
  formatTemperature,
  renderConfigUnreadable,
  renderEditorControls,
  renderError,
  renderHaChanges,
  renderHeader,
  renderHouse,
  renderOtherValves,
  renderPending,
  renderPlan,
  renderProblems,
  renderRooms,
  renderUnused,
  renderUpgrade,
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
const ru = DICTIONARIES.ru;
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
    describe("For a stranded managed valve", () => {
      it("returns forget", () => {
        expect(
          valveActions(
            valveView({ supported: false, roomId: "r", membership: "managed", stranded: true }),
          ),
        ).toEqual(["forget"]);
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
    describe("With a stranded valve in the room", () => {
      it("the valve says it is gone and has a forget button carrying its id", () => {
        const state = stateView({
          rooms: [room],
          valves: [
            valveView({
              valveId: ID,
              supported: false,
              roomId: "living",
              membership: "managed",
              stranded: true,
            }),
          ],
        });
        const out = renderRooms(state, "en", t);
        expect(text(out)).toContain(en["valve.stranded"]);
        expect(button(out, "forget")?.dataset.valveId).toBe(ID);
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
    describe("With a room named <b>x</b>", () => {
      it("the page shows those characters and holds no b element", () => {
        const state = stateView({ rooms: [roomView({ name: "<b>x</b>" })] });
        const out = renderRooms(state, "en", t);
        expect(text(out)).toContain("<b>x</b>");
        expect(out.querySelector("b")).toBeNull();
      });
    });
    describe("With a managed room and its schedule", () => {
      it("shows its area name and its schedule's name, and no not-managed mark", () => {
        const state = stateView({
          rooms: [roomView({ name: "Attic", scheduleId: "day", scheduleName: "Daytime" })],
        });
        const out = text(renderRooms(state, "en", t));
        expect(out).toContain("Attic");
        expect(out).toContain(t("room.schedule", { name: "Daytime" }));
        expect(out).not.toContain(en["room.not_managed"]);
      });
    });
    describe("With a room that is not managed (an area with a valve and no config yet)", () => {
      it('shows "not managed" and says nothing is written to its valves', () => {
        const state = stateView({
          configState: "empty",
          rooms: [roomView({ name: "Attic", managed: false })],
        });
        const out = text(renderRooms(state, "en", t));
        expect(out).toContain(en["room.not_managed"]);
        expect(out).toContain(en["room.not_managed_hint.no_config"]);
        expect(en["room.not_managed_hint.no_config"]).toContain("writes nothing");
        expect(out).toContain(en["room.no_schedule"]);
      });
    });
    describe("With a room that is not managed, by its cause", () => {
      it.each([
        ["no Home Assistant link", { house: "unlinked" }, "room.not_managed_hint.unlinked"],
        ["an unreadable config", { configState: "unreadable" }, "room.not_managed_hint.no_config"],
        [
          "a saved config with no schedule (a fresh install)",
          { revision: 0 },
          "room.not_managed_hint.no_schedule",
        ],
      ] as const)("with %s, the hint names that cause", (_, over, key) => {
        const state = stateView({ ...over, rooms: [roomView({ managed: false })] });
        const out = text(renderRooms(state, "en", t));
        expect(out).toContain(en[key]);
        expect(out).not.toContain(en["room.not_managed_hint"]);
      });
    });
    describe("With no rooms while the house is not live", () => {
      it("says rooms are not known without Home Assistant, not that no area holds a valve", () => {
        for (const house of ["frozen", "unlinked"] as const) {
          const out = text(renderRooms(stateView({ house }), "en", t));
          expect(out).toContain(en["rooms.unknown"]);
          expect(out).not.toContain(en["rooms.none"]);
        }
      });
    });
    describe("With no rooms", () => {
      it('shows the "no rooms" text', () => {
        expect(text(renderRooms(stateView(), "en", t))).toContain(en["rooms.none"]);
      });
    });
  });

  describe("renderHouse", () => {
    describe("With house frozen before the first load", () => {
      it("shows the not_loaded text", () => {
        const state = stateView({ house: "frozen", frozenReason: "not_loaded" });
        expect(text(renderHouse(state, t))).toBe(en["house.frozen.not_loaded"]);
      });
    });
    describe("With house frozen after the link went down", () => {
      it("shows the link_down text", () => {
        const state = stateView({ house: "frozen", frozenReason: "link_down" });
        expect(text(renderHouse(state, t))).toBe(en["house.frozen.link_down"]);
      });
    });
    describe("With house unlinked", () => {
      it("shows the unlinked text", () => {
        expect(text(renderHouse(stateView({ house: "unlinked" }), t))).toBe(en["house.unlinked"]);
      });
    });
    describe("With house live", () => {
      it("shows nothing", () => {
        expect(text(renderHouse(stateView(), t))).toBe("");
      });
    });
  });

  describe("renderConfigUnreadable", () => {
    describe('With configState "unreadable"', () => {
      it("says the file is unchanged, names the v2 rules, and tells how to recover", () => {
        const out = text(renderConfigUnreadable(stateView({ configState: "unreadable" }), t));
        expect(out).toContain(en["config_unreadable.title"]);
        expect(out).toContain("label_id_duplicate");
        expect(out).toContain("schedule_id_reserved");
        expect(out).toContain("has not been changed");
        expect(out).toContain("Overwrite the unreadable configuration");
        expect(out).toContain("config.unreadable.");
      });
      it("is the same in Russian and names the recovery steps", () => {
        const ru = translator("ru");
        const out = text(renderConfigUnreadable(stateView({ configState: "unreadable" }), ru));
        expect(out).toContain("label_id_duplicate");
        expect(out).toContain("Перезаписать нечитаемую конфигурацию");
      });
    });
    describe('With configState "ok"', () => {
      it("shows nothing", () => {
        expect(text(renderConfigUnreadable(stateView(), t))).toBe("");
      });
    });
  });

  describe("renderPending", () => {
    const pending = (reason: PendingReason, unreadable: readonly SettingKey[] = []) =>
      stateView({
        rooms: [roomView({ roomId: "hall", name: "Hall" })],
        pending: [{ valveId: ID, name: "Hall valve", roomId: "hall", reason, unreadable }],
      });
    describe("With a valve pending with originals_unreadable", () => {
      it("shows its name, room and reason, and an Accept button for it", () => {
        const out = renderPending(pending("originals_unreadable", ["sensor_source"]), t);
        expect(text(out)).toContain("Hall valve");
        expect(text(out)).toContain("Hall");
        expect(text(out)).toContain(en["pending.reason.originals_unreadable"]);
        expect(text(out)).toContain(en["setting.sensor_source"]);
        expect(button(out, "accept-originals")?.dataset.valveId).toBe(ID);
      });
    });
    describe("With a valve pending with valve_not_observed", () => {
      it("shows its reason and no Accept button", () => {
        const out = renderPending(pending("valve_not_observed"), t);
        expect(text(out)).toContain(en["pending.reason.valve_not_observed"]);
        expect(button(out, "accept-originals")).toBeNull();
      });
    });
    describe("With each pending reason", () => {
      it("shows readable text in en and ru, never the raw code", () => {
        for (const language of ["en", "ru"] as const) {
          for (const reason of [
            "house_frozen",
            "ledger_unreadable",
            "transport_unusable",
            "valve_not_observed",
            "originals_unreadable",
          ] as const) {
            const out = text(renderPending(pending(reason), translator(language)));
            expect(out, `${language} ${reason}`).not.toContain(reason);
          }
        }
      });
    });
    describe("With no pending valve", () => {
      it("shows nothing", () => {
        expect(text(renderPending(stateView(), t))).toBe("");
      });
    });
  });

  describe("renderUnused", () => {
    describe("With the unused entry attic", () => {
      it("lists attic with the hint", () => {
        const out = text(renderUnused(stateView({ unusedEntries: ["attic"] }), t));
        expect(out).toContain("attic");
        expect(out).toContain(en["unused.hint"]);
      });
    });
    describe("With no unused entry", () => {
      it("shows nothing", () => {
        expect(text(renderUnused(stateView(), t))).toBe("");
      });
    });
  });

  describe("renderHaChanges", () => {
    describe("With two HA changes", () => {
      it("lists the newer first, each with its time and items", () => {
        const older = Date.UTC(2026, 10, 1, 8, 0);
        const newer = Date.UTC(2026, 10, 2, 9, 30);
        const state = stateView({
          rooms: [
            roomView({ roomId: "hall", name: "Hall" }),
            roomView({ roomId: "den", name: "Den", scheduleId: "night", scheduleName: "Nights" }),
          ],
          haChanges: [
            {
              revision: 4,
              at: older,
              items: [{ kind: "sensor_added", areaId: "hall", entityId: "sensor.t1" }],
            },
            {
              revision: 5,
              at: newer,
              items: [{ kind: "schedule", areaId: "hall", scheduleId: "night" }],
            },
          ],
        });
        const out = renderHaChanges(state, "en", t);
        const entries = [...out.querySelectorAll("li.ha-change")].map((li) => li.textContent);
        const stamp = (at: number) =>
          new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(at),
          );
        expect(entries).toHaveLength(2);
        expect(entries[0]).toContain("Revision 5");
        expect(entries[0]).toContain(stamp(newer));
        expect(entries[0]).toContain("Schedule of Hall: Nights");
        expect(entries[1]).toContain("Revision 4");
        expect(entries[1]).toContain(stamp(older));
        expect(entries[1]).toContain("Sensor sensor.t1 added to Hall");
        expect(text(out)).toContain(en["ha_changes.title"]);
      });
    });
    describe("With no HA change", () => {
      it("shows nothing", () => {
        expect(text(renderHaChanges(stateView(), "en", t))).toBe("");
      });
    });
  });

  describe("renderUpgrade", () => {
    describe("With a report dropping a room without an area", () => {
      it("names the room, its valves and the reason, with a Dismiss button", () => {
        const state = stateView({
          upgrade: {
            fromVersion: 2,
            droppedRooms: [{ roomId: "bath", name: "Bath", valveIds: [ID], reason: "no_area" }],
          },
        });
        const out = renderUpgrade(state, t);
        expect(text(out)).toContain("Bath");
        expect(text(out)).toContain(ID);
        expect(text(out)).toContain(en["upgrade.dropped.no_area"]);
        expect(text(out)).toContain(en["upgrade.dropped_intro"]);
        expect(button(out, "dismiss-upgrade")).not.toBeNull();
      });
    });
    describe("With a report that dropped no room", () => {
      const state = stateView({ upgrade: { fromVersion: 2, droppedRooms: [] } });
      it("says every old room was kept, and nothing about rooms that could not be kept (en)", () => {
        const out = text(renderUpgrade(state, t));
        expect(out).toContain(en["upgrade.intro"]);
        expect(out).toContain(en["upgrade.none_dropped"]);
        expect(out).not.toContain(en["upgrade.dropped_intro"]);
        expect(out).not.toContain("could not be kept");
      });
      it("says the same in Russian", () => {
        const out = text(renderUpgrade(state, translator("ru")));
        expect(out).toContain(ru["upgrade.none_dropped"]);
        expect(out).not.toContain("сохранить не удалось");
      });
    });
    describe("Without a report", () => {
      it("shows nothing", () => {
        expect(text(renderUpgrade(stateView(), t))).toBe("");
      });
    });
  });

  describe("renderOtherValves", () => {
    describe("With a valve in an ignored area", () => {
      it("shows the ignored_area reason", () => {
        const state = stateView({
          valves: [valveView({ valveId: ID, name: "Spare" })],
          unassigned: [
            {
              valveId: ID,
              name: "Spare",
              observed: false,
              liveness: "unknown",
              values: {},
              reason: "ignored_area",
            },
          ],
        });
        expect(text(renderOtherValves(state, t))).toContain(en["unassigned.reason.ignored_area"]);
      });
    });
  });

  describe("renderOtherValves", () => {
    describe("With a valve in no room while the house is not live", () => {
      it("does not tell the user to put it into an area", () => {
        const state = stateView({ house: "frozen", valves: [valveView({ valveId: ID })] });
        const out = text(renderOtherValves(state, t));
        expect(out).toContain(en["others.hint_without_ha"]);
        expect(out).not.toContain(en["others.hint"]);
      });
    });
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

  describe("renderRooms thermostat state", () => {
    const at = new Date(2026, 10, 23, 18, 0).getTime();
    const withThermostat = (thermostat: NonNullable<RoomView["thermostat"]>) =>
      stateView({
        rooms: [roomView({ roomId: "den", valveIds: [ID], thermostat })],
        valves: [valveView({ valveId: ID, name: "Кабинет TRV" })],
      });
    describe("With a room on its schedule", () => {
      it("the state line says it follows the schedule and there is no resume button", () => {
        const out = renderRooms(withThermostat({ kind: "schedule" }), "en", t);
        expect(out.querySelector(".room-state")?.textContent).toBe(en["room.state.schedule"]);
        expect(button(out, "resume")).toBeNull();
      });
    });
    describe("With an override at 22 until 18:00 from valve Кабинет TRV", () => {
      const state = withThermostat({
        kind: "override",
        target: 22,
        rule: "timer",
        endsAt: at,
        origin: { source: "valve", valveId: ID },
      });
      it("the state line shows 22 °C, 18:00 and the valve's name", () => {
        const out = text(renderRooms(state, "ru", translator("ru")));
        expect(out).toContain("22,0 °C");
        expect(out).toContain("18:00");
        expect(out).toContain("Кабинет TRV");
      });
      it("a resume button carries the room id", () => {
        expect(button(renderRooms(state, "en", t), "resume")?.dataset.roomId).toBe("den");
      });
    });
    describe("With a manual override", () => {
      it('the end reads "you cancel"', () => {
        const out = text(
          renderRooms(withThermostat({ kind: "override", target: 22, rule: "manual" }), "en", t),
        );
        expect(out).toContain("Set to 22.0 °C until you cancel");
      });
    });
    describe("With the room off with rule next_change", () => {
      it("the state line says off until the next schedule change", () => {
        const out = renderRooms(withThermostat({ kind: "off", rule: "next_change" }), "en", t);
        expect(out.querySelector(".room-state")?.textContent).toBe(
          "Off until the next schedule change",
        );
        expect(button(out, "resume")).not.toBeNull();
      });
    });
    describe("With a change made through Home Assistant or this page", () => {
      it("the origin reads Home Assistant or this page", () => {
        const climate = withThermostat({
          kind: "off",
          rule: "manual",
          origin: { source: "climate" },
        });
        const api = withThermostat({ kind: "off", rule: "manual", origin: { source: "api" } });
        expect(text(renderRooms(climate, "en", t))).toContain("Changed on Home Assistant");
        expect(text(renderRooms(api, "en", t))).toContain("Changed on this page");
      });
    });
    describe("With no thermostat key", () => {
      it("no state line and no resume button", () => {
        const { thermostat, ...bare } = roomView();
        expect(thermostat).toBeDefined();
        const state = stateView({ rooms: [bare] });
        const out = renderRooms(state, "en", t);
        expect(out.querySelector(".room-state")).toBeNull();
        expect(button(out, "resume")).toBeNull();
      });
    });
  });

  describe("renderProblems state_unreadable", () => {
    describe("With state_unreadable", () => {
      it("a Start over button is shown", () => {
        const problem = problemView({
          kind: "state_unreadable",
          subject: { kind: "system", id: "system" },
        });
        const out = renderProblems(stateView({ problems: [problem] }), t);
        expect(button(out, "reset-thermostats")?.textContent).toBe(en["room.reset"]);
      });
    });
    describe("With no state_unreadable", () => {
      it("no Start over button is shown", () => {
        expect(
          button(renderProblems(stateView({ problems: [problemView()] }), t), "reset-thermostats"),
        ).toBeNull();
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
    describe("With legacy_label_present for a room", () => {
      it("names the room and room_temperature_sensor", () => {
        const state = stateView({
          problems: [
            problemView({
              kind: "legacy_label_present",
              subject: { kind: "room", id: "hall" },
              name: "Hall",
              data: { entities: "sensor.a,sensor.b" },
            }),
          ],
        });
        const out = text(renderProblems(state, t));
        expect(out).toContain("Hall");
        expect(out).toContain("room_temperature_sensor");
        expect(out).toContain("sensor.a, sensor.b");
      });
    });
    describe("With entry_unavailable for an area", () => {
      it("names the area and its labels, comma separated", () => {
        const state = stateView({
          problems: [
            problemView({
              kind: "entry_unavailable",
              subject: { kind: "area", id: "loft" },
              name: "Loft",
              data: { labels: "heatmaster_schedule_night,room_temperature_sensor" },
            }),
          ],
        });
        const out = text(renderProblems(state, t));
        expect(out).toContain("Loft");
        expect(out).toContain("heatmaster_schedule_night, room_temperature_sensor");
      });
    });
    describe("With sensor_label_unused and the reason sensor_on_valve", () => {
      it("shows the reason in words", () => {
        const state = stateView({
          problems: [
            problemView({
              kind: "sensor_label_unused",
              subject: { kind: "sensor", id: "ha:sensor.a" },
              name: "Sensor A",
              data: { reason: "sensor_on_valve" },
            }),
          ],
        });
        expect(text(renderProblems(state, t))).toContain(
          en["problem.sensor_label_unused.sensor_on_valve"],
        );
      });
    });
    describe("With contact_label_unused and the reason contact_limit", () => {
      it("shows the reason in words", () => {
        const state = stateView({
          problems: [
            problemView({
              kind: "contact_label_unused",
              subject: { kind: "sensor", id: "ha:binary_sensor.a" },
              name: "Window A",
              data: { reason: "contact_limit" },
            }),
          ],
        });
        expect(text(renderProblems(state, t))).toContain(
          en["problem.contact_label_unused.contact_limit"],
        );
      });
    });
    describe("With valve_pending for a valve and its room", () => {
      it("names the valve, the room's name and the reason in words", () => {
        const state = stateView({
          rooms: [roomView({ roomId: "hall", name: "Hall" })],
          problems: [
            problemView({
              kind: "valve_pending",
              name: "Hall valve",
              data: { reason: "valve_not_observed", roomId: "hall", settings: "" },
            }),
          ],
        });
        const out = text(renderProblems(state, t));
        expect(out).toContain("Hall valve");
        expect(out).toContain("room Hall");
        expect(out).toContain(en["pending.reason.valve_not_observed"]);
      });
    });
    describe("With rooms_frozen and ha_label_failed", () => {
      it("shows the frozen reason and the failed operation in words", () => {
        const state = stateView({
          problems: [
            problemView({
              kind: "rooms_frozen",
              subject: { kind: "system", id: "system" },
              data: { reason: "link_down" },
            }),
            problemView({
              kind: "ha_label_failed",
              subject: { kind: "label", id: "heatmaster_schedule_day" },
              name: "heatmaster_schedule_day",
              data: { op: "createLabel", error: "unauthorized" },
            }),
          ],
        });
        const out = text(renderProblems(state, t));
        expect(out).toContain(en["frozen_reason.link_down"]);
        expect(out).toContain(en["label_op.createLabel"]);
        expect(out).toContain(en["label_error.unauthorized"]);
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
    describe("With state_unreadable", () => {
      it("the text says no mode or setpoint is written", () => {
        const problem = problemView({
          kind: "state_unreadable",
          subject: { kind: "system", id: "heatmaster" },
          name: "heatmaster",
          data: {},
        });
        expect(text(renderProblems(stateView({ problems: [problem] }), t))).toContain(
          en["problem.state_unreadable"],
        );
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
    describe("With a pending valve in the plan", () => {
      it("lists it with its reason", () => {
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
        const out = text(renderPlan(plan, t, []));
        expect(out).toContain("Waiting valve");
        expect(out).toContain(en["pending.reason.valve_not_observed"]);
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
        expect(headings).toEqual([en["plan.pending"], en["plan.writes"]]);
      });
    });
  });

  describe("renderError", () => {
    describe("With every error text and the data the server sends for its code", () => {
      it("shows no raw {placeholder}, in en and ru", () => {
        const sent: Record<string, Record<string, string>> = {
          revision_conflict: { expected: "1", current: "2" },
          ha_link_missing: { sensor: "s" },
          sensor_unknown: { sensor: "s" },
          sensor_not_temperature: { sensor: "s" },
          sensor_on_valve: { sensor: "s" },
          contact_unknown: { contact: "c" },
          contact_not_binary: { contact: "c" },
          valve_unknown: { valveId: ID },
          valve_unsupported: { valveId: ID },
          ledger_unreadable: { valveId: ID },
          transport_unusable: { valveId: ID },
          valve_not_orphan: { valveId: ID },
          valve_managed: { valveId: ID },
          valve_not_pending: { valveId: ID },
          schedule_in_use: { roomId: "hall" },
          mqtt_fault: { reason: "mqtt_unavailable" },
          room_unknown: { roomId: "hall" },
          schedule_unknown: { scheduleId: "night" },
          ask_limited: { valveId: ID },
          device_unknown: { deviceId: ID },
          mqtt_refused: { reasonCode: "135" },
          topic_invalid: { topic: "a/#" },
        };
        for (const language of ["en", "ru"] as const) {
          const tr = translator(language);
          for (const key of Object.keys(DICTIONARIES[language])) {
            if (!key.startsWith("error.") || key === "error.http") continue;
            const code = key.slice("error.".length);
            const out = text(renderError(apiError(code, sent[code] ?? {}), tr));
            expect(out, `${language} ${key}`).not.toContain("{");
          }
        }
      });
    });
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
