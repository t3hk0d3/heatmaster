import { DEFAULT_WINDOW_SETTINGS } from "@heatmaster/core";
import type {
  ProblemView,
  RoomChoice,
  RoomView,
  StateView,
  ThermostatCommand,
  WindowView,
} from "@heatmaster/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startFakeZ2m, type FakeZ2m } from "../test/fake-z2m.ts";
import {
  ENTITY_TEXTS,
  PRESS_TOPIC,
  PROBLEMS_TOPIC,
  SYNC_OPTIONS,
  SYSTEM_STATE_TOPIC,
  configMessages,
  createDiscovery,
  roomCommandTopic,
  roomConfigTopic,
  roomStateTopic,
  stateMessages,
  systemConfigTopic,
  type DiscoveryDeps,
  type DiscoveryMqtt,
  type DiscoveryOptions,
} from "./discovery.ts";
import { systemClock } from "./clock.ts";
import { createMqttClient, type MqttEvent, type MqttState } from "./mqtt.ts";

const OPTIONS: DiscoveryOptions = { prefix: "homeassistant", version: "1.2.3" };
const WAIT = { timeout: 10 * 1000, interval: 5 };

function room(id: string, extra: Partial<RoomView> = {}): RoomView {
  return {
    roomId: id,
    name: id.toUpperCase(),
    managed: true,
    currentTemperature: 19.6,
    target: 20,
    sync: "in_sync",
    degraded: false,
    hasProblem: false,
    valveIds: [],
    ...extra,
  };
}

function problem(n: number): ProblemView {
  return {
    kind: "valve_silent",
    subject: { kind: "valve", id: `z2m:${String(n)}` },
    severity: "warning",
    name: `Valve ${String(n)}`,
    data: { n: String(n) },
  };
}

function view(extra: Partial<StateView> = {}): StateView {
  return {
    revision: 1,
    configState: "ok",
    house: "live",
    ledgerReadable: true,
    originalsCopyRecords: 0,
    held: false,
    language: "en",
    links: {},
    transportFaults: {},
    rooms: [room("a"), room("b")],
    unusedEntries: [],
    valves: [],
    unassigned: [],
    pending: [],
    problems: [],
    haChanges: [],
    schedules: [],
    ...extra,
  };
}

// Parsed discovery payloads are walked by key in many places; a typed walk would only repeat them.
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
type Config = any;
function parse(text: string | undefined): Config {
  return JSON.parse(text ?? "null");
}

describe("discovery", () => {
  describe("roomStateTopic / roomConfigTopic / systemConfigTopic", () => {
    describe('With room id "living_room" and prefix "homeassistant"', () => {
      it("return heatmaster/rooms/living_room/state, homeassistant/device/heatmaster/room_living_room/config and homeassistant/device/heatmaster/system/config", () => {
        expect(roomStateTopic("living_room")).toBe("heatmaster/rooms/living_room/state");
        expect(roomConfigTopic("homeassistant", "living_room")).toBe(
          "homeassistant/device/heatmaster/room_living_room/config",
        );
        expect(systemConfigTopic("homeassistant")).toBe(
          "homeassistant/device/heatmaster/system/config",
        );
      });
    });
  });

  describe("configMessages", () => {
    describe("With two rooms", () => {
      it("returns three topics: the system device first, then the rooms in order", () => {
        expect([...configMessages(view(), OPTIONS).keys()]).toEqual([
          systemConfigTopic("homeassistant"),
          roomConfigTopic("homeassistant", "a"),
          roomConfigTopic("homeassistant", "b"),
        ]);
      });
    });

    describe('With prefix "ha_test"', () => {
      it("every topic starts with ha_test/device/heatmaster/", () => {
        for (const topic of configMessages(view(), { ...OPTIONS, prefix: "ha_test" }).keys()) {
          expect(topic.startsWith("ha_test/device/heatmaster/")).toBe(true);
        }
      });
    });

    describe("For a room device", () => {
      const config = parse(
        configMessages(view(), OPTIONS).get(roomConfigTopic("homeassistant", "a")),
      );
      it('identifiers is ["heatmaster_room_<id>"], name is the room\'s name, via_device is "heatmaster"', () => {
        expect(config.device).toMatchObject({
          identifiers: ["heatmaster_room_a"],
          name: "A",
          via_device: "heatmaster",
        });
      });
      it("origin holds the name Heatmaster, the version and the support URL", () => {
        expect(config.origin).toEqual({
          name: "Heatmaster",
          sw_version: "1.2.3",
          support_url: "https://github.com/t3hk0d3/heatmaster",
        });
      });
      it("availability_topic is heatmaster/status", () => {
        expect(config.availability_topic).toBe("heatmaster/status");
      });
      it("components holds exactly the seven plain ones and the seven window ones", () => {
        expect(Object.keys(config.components)).toEqual([
          "temperature",
          "target",
          "problem",
          "sync",
          "climate",
          "schedule",
          "override_end",
          "window",
          "window_enabled",
          "window_temperature",
          "window_action",
          "window_end",
          "window_limit",
          "window_manual_change",
        ]);
      });
      it("every sensor's and select's state_topic is the room's state topic", () => {
        for (const key of [
          "temperature",
          "target",
          "problem",
          "sync",
          "schedule",
          "override_end",
        ]) {
          expect(config.components[key].state_topic).toBe("heatmaster/rooms/a/state");
        }
      });
      it("temperature has device class temperature, unit °C, state class measurement", () => {
        const temperature = config.components.temperature;
        expect(temperature).toMatchObject({
          device_class: "temperature",
          unit_of_measurement: "°C",
          state_class: "measurement",
          suggested_display_precision: 1,
        });
      });
      it("problem is a binary_sensor with device class problem", () => {
        const entity = config.components.problem;
        expect(entity).toMatchObject({
          platform: "binary_sensor",
          device_class: "problem",
          entity_category: "diagnostic",
        });
      });
      it("sync has device class enum, the six options in order, no unit and no state class", () => {
        const entity = config.components.sync;
        expect(entity.device_class).toBe("enum");
        expect(entity.options).toEqual([...SYNC_OPTIONS]);
        expect(SYNC_OPTIONS).toHaveLength(6);
        expect(Object.hasOwn(entity, "unit_of_measurement")).toBe(false);
        expect(Object.hasOwn(entity, "state_class")).toBe(false);
      });
      it("no component of the system device has the platform climate", () => {
        const system = parse(
          configMessages(view(), OPTIONS).get(systemConfigTopic("homeassistant")),
        );
        for (const component of Object.values<Config>(system.components)) {
          expect(component.platform).not.toBe("climate");
        }
      });
    });

    for (const language of ["en", "ru"] as const) {
      describe(`With language "${language}"`, () => {
        const config = parse(
          configMessages(view({ language }), OPTIONS).get(roomConfigTopic("homeassistant", "a")),
        );
        it(`target is named "${ENTITY_TEXTS[language].target}"`, () => {
          expect(config.components.target.name).toBe(ENTITY_TEXTS[language].target);
        });
        it(`sync is named "${ENTITY_TEXTS[language].sync}"`, () => {
          expect(config.components.sync.name).toBe(ENTITY_TEXTS[language].sync);
        });
        it("every room component is named from the language's texts", () => {
          const texts = ENTITY_TEXTS[language];
          const names = Object.fromEntries(
            Object.entries<Config>(config.components).map(([key, component]) => [
              key,
              component.name,
            ]),
          );
          expect(names).toEqual({
            temperature: texts.temperature,
            target: texts.target,
            problem: texts.problem,
            sync: texts.sync,
            climate: texts.thermostat,
            schedule: texts.schedule,
            override_end: texts.overrideEnd,
            window: texts.window,
            window_enabled: texts.windowEnabled,
            window_temperature: texts.windowTemperature,
            window_action: texts.windowAction,
            window_end: texts.windowEnd,
            window_limit: texts.windowLimit,
            window_manual_change: texts.windowManualChange,
          });
        });
        it("every system component is named from the language's texts", () => {
          const texts = ENTITY_TEXTS[language];
          const system = parse(
            configMessages(view({ language }), OPTIONS).get(systemConfigTopic("homeassistant")),
          );
          const names = Object.fromEntries(
            Object.entries<Config>(system.components).map(([key, component]) => [
              key,
              component.name,
            ]),
          );
          expect(names).toEqual({
            problem: texts.problem,
            problem_count: texts.problemCount,
            held: texts.held,
            stop_writing: texts.stopWriting,
          });
        });
        it(`the device model is "${ENTITY_TEXTS[language].roomModel}"`, () => {
          expect(config.device.model).toBe(ENTITY_TEXTS[language].roomModel);
        });
      });
    }

    describe('With a managed room office named "Кабинет"', () => {
      const config = parse(
        configMessages(view({ rooms: [room("office", { name: "Кабинет" })] }), OPTIONS).get(
          roomConfigTopic("homeassistant", "office"),
        ),
      );

      it("unique ids start with heatmaster_room_office", () => {
        const ids = Object.values<Config>(config.components).map((c) => c.unique_id as string);
        expect(ids.length).toBeGreaterThan(0);
        for (const id of [...ids, ...(config.device.identifiers as string[])]) {
          expect(id.startsWith("heatmaster_room_office")).toBe(true);
        }
      });

      it("default_entity_id of the temperature is sensor.heatmaster_office_temperature", () => {
        expect(config.components.temperature.default_entity_id).toBe(
          "sensor.heatmaster_office_temperature",
        );
      });

      it('the device name and suggested_area are "Кабинет"', () => {
        expect(config.device.name).toBe("Кабинет");
        expect(config.device.suggested_area).toBe("Кабинет");
      });
    });

    describe("With a listed room that is not managed", () => {
      it("it has no device", () => {
        const state = view({ rooms: [room("a"), room("b", { managed: false })] });
        expect([...configMessages(state, OPTIONS).keys()]).toEqual([
          systemConfigTopic("homeassistant"),
          roomConfigTopic("homeassistant", "a"),
        ]);
        expect(stateMessages(state).has(roomStateTopic("b"))).toBe(false);
      });
    });

    describe("When the area is renamed", () => {
      it("the device name changes and every id stays", () => {
        const before = parse(
          configMessages(view({ rooms: [room("office", { name: "Office" })] }), OPTIONS).get(
            roomConfigTopic("homeassistant", "office"),
          ),
        );
        const after = parse(
          configMessages(view({ rooms: [room("office", { name: "Study" })] }), OPTIONS).get(
            roomConfigTopic("homeassistant", "office"),
          ),
        );
        expect([before.device.name, after.device.name]).toEqual(["Office", "Study"]);
        const ids = (config: Config): unknown => ({
          identifiers: config.device.identifiers,
          components: Object.fromEntries(
            Object.entries<Config>(config.components).map(([key, c]) => [
              key,
              [c.unique_id, c.default_entity_id, c.state_topic],
            ]),
          ),
        });
        expect(ids(after)).toEqual(ids(before));
      });
    });

    describe('With a room named Bedroom "north", or Спальня', () => {
      it("the payload parses as JSON and holds the name unchanged", () => {
        for (const name of ['Bedroom "north"', "Спальня"]) {
          const text = configMessages(view({ rooms: [room("a", { name })] }), OPTIONS).get(
            roomConfigTopic("homeassistant", "a"),
          );
          expect(parse(text).device.name).toBe(name);
        }
      });
    });

    describe("For the default entity ids", () => {
      it("each room component has <platform>.heatmaster_<roomId>_<key>, the climate without the key", () => {
        const config = parse(
          configMessages(view(), OPTIONS).get(roomConfigTopic("homeassistant", "a")),
        );
        expect(
          Object.fromEntries(
            Object.entries<Config>(config.components).map(([key, c]) => [key, c.default_entity_id]),
          ),
        ).toEqual({
          temperature: "sensor.heatmaster_a_temperature",
          target: "sensor.heatmaster_a_target",
          problem: "binary_sensor.heatmaster_a_problem",
          sync: "sensor.heatmaster_a_sync",
          climate: "climate.heatmaster_a",
          schedule: "select.heatmaster_a_schedule",
          override_end: "select.heatmaster_a_override_end",
          window: "binary_sensor.heatmaster_a_window",
          window_enabled: "switch.heatmaster_a_window_enabled",
          window_temperature: "switch.heatmaster_a_window_temperature",
          window_action: "select.heatmaster_a_window_action",
          window_end: "select.heatmaster_a_window_end",
          window_limit: "select.heatmaster_a_window_limit",
          window_manual_change: "select.heatmaster_a_window_manual_change",
        });
      });
      it("a hyphen in the room id becomes an underscore", () => {
        const config = parse(
          configMessages(view({ rooms: [room("living-room")] }), OPTIONS).get(
            roomConfigTopic("homeassistant", "living-room"),
          ),
        );
        expect(config.components.temperature.default_entity_id).toBe(
          "sensor.heatmaster_living_room_temperature",
        );
        expect(config.components.problem.default_entity_id).toBe(
          "binary_sensor.heatmaster_living_room_problem",
        );
      });
      it("each system component has <platform>.heatmaster_<key>", () => {
        const config = parse(
          configMessages(view(), OPTIONS).get(systemConfigTopic("homeassistant")),
        );
        expect(
          Object.fromEntries(
            Object.entries<Config>(config.components).map(([key, c]) => [key, c.default_entity_id]),
          ),
        ).toEqual({
          problem: "binary_sensor.heatmaster_problem",
          problem_count: "sensor.heatmaster_problem_count",
          held: "binary_sensor.heatmaster_held",
          stop_writing: "button.heatmaster_stop_writing",
        });
      });
      it("the unique ids are unchanged", () => {
        const config = parse(
          configMessages(view(), OPTIONS).get(roomConfigTopic("homeassistant", "a")),
        );
        expect(config.components.temperature.unique_id).toBe("heatmaster_room_a_temperature");
        expect(config.components.problem.unique_id).toBe("heatmaster_room_a_problem");
      });
    });

    describe("For the Heatmaster device", () => {
      const config = parse(configMessages(view(), OPTIONS).get(systemConfigTopic("homeassistant")));
      it('identifiers is ["heatmaster"]', () => {
        expect(config.device.identifiers).toEqual(["heatmaster"]);
      });
      it("components holds exactly problem, problem_count, held and stop_writing", () => {
        expect(Object.keys(config.components)).toEqual([
          "problem",
          "problem_count",
          "held",
          "stop_writing",
        ]);
      });
      it("problem_count is a measurement and a diagnostic", () => {
        expect(config.components.problem_count).toMatchObject({
          state_class: "measurement",
          entity_category: "diagnostic",
        });
      });
      it("problem_count has json_attributes_topic heatmaster/system/problems", () => {
        expect(config.components.problem_count.json_attributes_topic).toBe(
          "heatmaster/system/problems",
        );
      });
      it("stop_writing is a button with command topic heatmaster/system/stop_writing/press and payload_press PRESS", () => {
        expect(config.components.stop_writing).toMatchObject({
          platform: "button",
          command_topic: "heatmaster/system/stop_writing/press",
          payload_press: "PRESS",
        });
      });
      it("stop_writing has no state_topic", () => {
        expect(Object.hasOwn(config.components.stop_writing, "state_topic")).toBe(false);
      });
    });

    describe('With configState "unreadable" or "empty"', () => {
      it("returns only the system device", () => {
        for (const configState of ["unreadable", "empty"] as const) {
          expect([...configMessages(view({ configState }), OPTIONS).keys()]).toEqual([
            systemConfigTopic("homeassistant"),
          ]);
        }
      });
    });

    describe("With the same state twice", () => {
      it("returns equal texts", () => {
        expect([...configMessages(view(), OPTIONS)]).toEqual([...configMessages(view(), OPTIONS)]);
      });
    });
  });

  describe("configMessages (thermostat)", () => {
    const limited = room("a", {
      minTemp: 5,
      maxTemp: 30,
      overrideEnd: "manual",
      scheduleName: "Weekdays",
    });
    const schedules = [
      { id: "weekdays", name: "Weekdays" },
      { id: "weekend", name: "Weekend" },
    ];
    const configOf = (state: StateView): Config =>
      parse(configMessages(state, OPTIONS).get(roomConfigTopic("homeassistant", "a")));

    describe("For a managed room limited to 5–30", () => {
      const config = configOf(view({ rooms: [limited], schedules }));
      it("its config has a climate component with modes auto/heat/off, the four presets, min_temp 5, max_temp 30, temp_step 0.5", () => {
        expect(config.components.climate).toMatchObject({
          platform: "climate",
          modes: ["auto", "heat", "off"],
          preset_modes: ["comfort", "eco", "frost", "boost"],
          min_temp: 5,
          max_temp: 30,
          temp_step: 0.5,
          temperature_unit: "C",
          default_entity_id: "climate.heatmaster_a",
          name: "Thermostat",
        });
      });
      it("its climate reads the room state topic through templates and sends commands to the set topics", () => {
        expect(config.components.climate).toMatchObject({
          mode_state_topic: "heatmaster/rooms/a/state",
          mode_state_template: "{{ value_json.mode }}",
          mode_command_topic: roomCommandTopic("a", "mode"),
          temperature_state_topic: "heatmaster/rooms/a/state",
          temperature_state_template: "{{ value_json.target }}",
          temperature_command_topic: roomCommandTopic("a", "temperature"),
          current_temperature_topic: "heatmaster/rooms/a/state",
          current_temperature_template: "{{ value_json.temperature }}",
          preset_mode_state_topic: "heatmaster/rooms/a/state",
          preset_mode_value_template: "{{ value_json.preset }}",
          preset_mode_command_topic: roomCommandTopic("a", "preset"),
          action_topic: "heatmaster/rooms/a/state",
          action_template: "{{ value_json.action }}",
          json_attributes_topic: "heatmaster/rooms/a/state",
        });
        for (const key of ["rule", "ends_at", "origin", "next_change_at", "next_target"]) {
          expect(config.components.climate.json_attributes_template).toContain(
            `"${key}": value_json.${key}`,
          );
        }
      });
      it("its config has the selects schedule and override_end with their options", () => {
        expect(config.components.schedule).toMatchObject({
          platform: "select",
          options: ["Weekdays", "Weekend"],
          state_topic: "heatmaster/rooms/a/state",
          value_template: "{{ value_json.schedule }}",
          command_topic: roomCommandTopic("a", "schedule"),
          default_entity_id: "select.heatmaster_a_schedule",
        });
        expect(config.components.override_end).toMatchObject({
          platform: "select",
          options: ["Next schedule change", "For a set time", "Until cancelled"],
          state_topic: "heatmaster/rooms/a/state",
          value_template: "{{ value_json.override_end }}",
          command_topic: roomCommandTopic("a", "override_end"),
          default_entity_id: "select.heatmaster_a_override_end",
        });
      });
      it("unique ids end with _climate, _schedule and _override_end", () => {
        expect(config.components.climate.unique_id).toBe("heatmaster_room_a_climate");
        expect(config.components.schedule.unique_id).toBe("heatmaster_room_a_schedule");
        expect(config.components.override_end.unique_id).toBe("heatmaster_room_a_override_end");
      });
    });

    describe("With language ru", () => {
      it("the override_end options are the Russian texts", () => {
        const config = configOf(view({ language: "ru", rooms: [limited], schedules }));
        expect(config.components.override_end.options).toEqual([
          "До смены по расписанию",
          "На заданное время",
          "До отмены",
        ]);
      });
    });

    describe('With a room "Кабинет" with id office-1', () => {
      it("the climate's entity id has underscores for the dash", () => {
        const state = view({ rooms: [room("office-1", { name: "Кабинет" })] });
        const config = parse(
          configMessages(state, OPTIONS).get(roomConfigTopic("homeassistant", "office-1")),
        );
        expect(config.components.climate.default_entity_id).toBe("climate.heatmaster_office_1");
      });
    });
  });

  describe("configMessages (windows)", () => {
    const configOf = (language: "en" | "ru" = "en"): Config =>
      parse(
        configMessages(view({ language, rooms: [room("a")] }), OPTIONS).get(
          roomConfigTopic("homeassistant", "a"),
        ),
      );
    describe("For a managed room", () => {
      const config = configOf();
      it("adds a window binary_sensor with device class window and unique id heatmaster_room_<id>_window", () => {
        expect(config.components.window).toMatchObject({
          platform: "binary_sensor",
          device_class: "window",
          unique_id: "heatmaster_room_a_window",
          default_entity_id: "binary_sensor.heatmaster_a_window",
          state_topic: "heatmaster/rooms/a/state",
          value_template: "{{ value_json.window }}",
        });
      });
      it("adds the two switches with their command topics", () => {
        expect(config.components.window_enabled).toMatchObject({
          platform: "switch",
          unique_id: "heatmaster_room_a_window_enabled",
          default_entity_id: "switch.heatmaster_a_window_enabled",
          state_topic: "heatmaster/rooms/a/state",
          value_template: "{{ value_json.window_enabled }}",
          command_topic: "heatmaster/rooms/a/set/window_enabled",
          payload_on: "ON",
          payload_off: "OFF",
        });
        expect(config.components.window_temperature).toMatchObject({
          platform: "switch",
          unique_id: "heatmaster_room_a_window_temperature",
          value_template: "{{ value_json.window_temperature }}",
          command_topic: "heatmaster/rooms/a/set/window_temperature",
          payload_on: "ON",
          payload_off: "OFF",
        });
      });
      it("adds the four selects with their options in the entity language", () => {
        for (const language of ["en", "ru"] as const) {
          const texts = ENTITY_TEXTS[language];
          const components = configOf(language).components;
          expect(components.window_action.options).toEqual([
            texts.windowActionOptions.frost_heat,
            texts.windowActionOptions.off,
          ]);
          expect(components.window_end.options).toEqual([
            texts.windowEndOptions.fixed,
            texts.windowEndOptions.stopped_falling,
          ]);
          expect(components.window_limit.options).toEqual(texts.windowLimitOptions);
          expect(components.window_manual_change.options).toEqual([
            texts.windowManualChangeOptions.resume_heating,
            texts.windowManualChangeOptions.ignore,
          ]);
        }
        expect(ENTITY_TEXTS.en.windowLimitOptions).toEqual([
          "30 min",
          "1 h",
          "2 h",
          "4 h",
          "8 h",
          "none",
        ]);
        for (const key of ["action", "end", "limit", "manual_change"]) {
          expect(config.components[`window_${key}`]).toMatchObject({
            platform: "select",
            unique_id: `heatmaster_room_a_window_${key}`,
            value_template: `{{ value_json.window_${key} }}`,
            command_topic: `heatmaster/rooms/a/set/window_${key}`,
          });
        }
      });
    });
  });

  describe("stateMessages (windows)", () => {
    const payload = (extra: Partial<RoomView>): Config =>
      parse(stateMessages(view({ rooms: [room("a", extra)] })).get(roomStateTopic("a")));
    const settings = {
      ...DEFAULT_WINDOW_SETTINGS,
      limitMs: 2 * 60 * 60 * 1000,
    };
    const holding: WindowView = {
      state: "open",
      triggers: ["contact", "temperature"],
      openContacts: ["ha:binary_sensor.w"],
      since: Date.UTC(2026, 10, 27, 10, 0, 0),
      holdsValves: true,
    };
    describe("With an opening holding the valves", () => {
      const state = payload({
        window: holding,
        thermostat: { kind: "schedule" },
        heating: true,
        windowSettings: settings,
      });
      it("sets window ON and window_state open", () => {
        expect(state).toMatchObject({ window: "ON", window_state: "open" });
      });
      it("sets the climate action off", () => {
        expect(state.action).toBe("off");
      });
      it("sets window_triggers and window_since", () => {
        expect(state.window_triggers).toEqual(["contact", "temperature"]);
        expect(state.window_since).toBe("2026-11-27T10:00:00.000Z");
      });
    });
    describe("With the room's limit 90 min", () => {
      it("sets window_limit null", () => {
        expect(
          payload({ windowSettings: { ...settings, limitMs: 90 * 60 * 1000 } }).window_limit,
        ).toBeNull();
      });
    });
    describe("With the room's limit 4 h", () => {
      it("sets window_limit 4 h", () => {
        expect(
          payload({ windowSettings: { ...settings, limitMs: 4 * 60 * 60 * 1000 } }).window_limit,
        ).toBe("4 h");
      });
    });
    describe("With no limit", () => {
      it("sets window_limit none", () => {
        expect(payload({ windowSettings: { ...settings, limitMs: null } }).window_limit).toBe(
          "none",
        );
      });
    });
    describe("With no opening", () => {
      const state = payload({ windowSettings: settings });
      it("sets window OFF and window_state null", () => {
        expect(state).toMatchObject({ window: "OFF", window_state: null });
      });
      it("sets window_triggers empty and window_since null", () => {
        expect(state.window_triggers).toEqual([]);
        expect(state.window_since).toBeNull();
      });
    });
    describe("With a suspended opening", () => {
      it("sets window OFF and window_state suspended", () => {
        expect(
          payload({ window: { ...holding, state: "suspended", holdsValves: false } }),
        ).toMatchObject({ window: "OFF", window_state: "suspended" });
      });
    });
    describe("With the room's settings", () => {
      it("sets the switches and the selects from them", () => {
        const state = payload({
          windowSettings: {
            ...settings,
            enabled: false,
            action: "off",
            temperature: { ...settings.temperature, enabled: true, end: "stopped_falling" },
            manualChange: "ignore",
          },
        });
        expect(state).toMatchObject({
          window_enabled: "OFF",
          window_temperature: "ON",
          window_action: "Valves off",
          window_end: "Stopped falling",
          window_manual_change: "Ignore",
        });
      });
    });
    describe("With no window settings known", () => {
      it("sets the switches and selects null", () => {
        expect(payload({})).toMatchObject({
          window_enabled: null,
          window_temperature: null,
          window_action: null,
          window_end: null,
          window_limit: null,
          window_manual_change: null,
        });
      });
    });
  });

  describe("stateMessages", () => {
    const one = (state: StateView, topic: string): string | undefined =>
      stateMessages(state).get(topic);
    describe("With a room at 19.6 with target 20, in sync, not degraded, no problem", () => {
      it("its message holds the temperature, the target, the problem and the sync, and no thermostat state", () => {
        expect(parse(one(view(), roomStateTopic("a")))).toEqual({
          temperature: 19.6,
          target: 20,
          problem: "OFF",
          sync: "in_sync",
          mode: null,
          preset: "none",
          action: "idle",
          rule: null,
          ends_at: null,
          origin: null,
          next_change_at: null,
          next_target: null,
          schedule: null,
          override_end: null,
          window: "OFF",
          window_state: null,
          window_triggers: [],
          window_since: null,
          window_enabled: null,
          window_temperature: null,
          window_action: null,
          window_end: null,
          window_limit: null,
          window_manual_change: null,
        });
      });
    });
    describe("With a room overridden manual at 22 with preset comfort, heating", () => {
      const state = view({
        rooms: [
          room("a", {
            target: 22,
            heating: true,
            thermostat: {
              kind: "override",
              target: 22,
              preset: "comfort",
              rule: "manual",
              origin: { source: "api" },
            },
            overrideEnd: "manual",
          }),
        ],
      });
      it("mode heat, target 22, preset comfort, action heating, rule manual, ends_at null", () => {
        expect(parse(one(state, roomStateTopic("a")))).toMatchObject({
          mode: "heat",
          target: 22,
          preset: "comfort",
          action: "heating",
          rule: "manual",
          ends_at: null,
          origin: "api",
          override_end: "Until cancelled",
        });
      });
    });
    describe("With a room overridden until an instant", () => {
      it("ends_at is its ISO 8601 text", () => {
        const state = view({
          rooms: [
            room("a", {
              thermostat: {
                kind: "override",
                target: 21,
                rule: "timer",
                endsAt: Date.UTC(2026, 10, 20, 18, 30),
                origin: { source: "climate" },
              },
              nextChangeAt: Date.UTC(2026, 10, 20, 22, 0),
              nextTarget: 17,
            }),
          ],
        });
        expect(parse(one(state, roomStateTopic("a")))).toMatchObject({
          ends_at: "2026-11-20T18:30:00.000Z",
          next_change_at: "2026-11-20T22:00:00.000Z",
          next_target: 17,
          origin: "climate",
        });
      });
    });
    describe("With a room off", () => {
      it("mode off, target null, action off", () => {
        const state = view({
          rooms: [
            room("a", { target: 5, heating: true, thermostat: { kind: "off", rule: "manual" } }),
          ],
        });
        expect(parse(one(state, roomStateTopic("a")))).toMatchObject({
          mode: "off",
          target: null,
          action: "off",
        });
      });
    });
    describe("With a room on its schedule, idle", () => {
      it("mode auto, preset none, action idle", () => {
        const state = view({
          rooms: [
            room("a", {
              heating: false,
              thermostat: { kind: "schedule" },
              scheduleName: "Weekdays",
            }),
          ],
        });
        expect(parse(one(state, roomStateTopic("a")))).toMatchObject({
          mode: "auto",
          preset: "none",
          action: "idle",
          schedule: "Weekdays",
        });
      });
    });
    describe('With an override from valve "Кабинет TRV"', () => {
      it('origin "valve Кабинет TRV"', () => {
        const state = view({
          rooms: [
            room("a", {
              thermostat: {
                kind: "override",
                target: 21,
                rule: "manual",
                origin: { source: "valve", valveId: "z2m:1" },
              },
            }),
          ],
          valves: [{ valveId: "z2m:1", name: "Кабинет TRV", supported: true }],
        });
        expect(parse(one(state, roomStateTopic("a"))).origin).toBe("valve Кабинет TRV");
      });
    });
    describe("With a room whose temperature is unknown", () => {
      it("temperature is null", () => {
        const state = view({
          rooms: [{ ...room("a"), currentTemperature: undefined } as unknown as RoomView],
        });
        expect(parse(one(state, roomStateTopic("a"))).temperature).toBeNull();
      });
    });
    describe("With a degraded room", () => {
      it('problem is "ON"', () => {
        const state = view({ rooms: [room("a", { degraded: true })] });
        expect(parse(one(state, roomStateTopic("a"))).problem).toBe("ON");
      });
    });
    describe("With a room that is not degraded but has a problem", () => {
      it('problem is "ON"', () => {
        const state = view({ rooms: [room("a", { hasProblem: true })] });
        expect(parse(one(state, roomStateTopic("a"))).problem).toBe("ON");
      });
    });
    describe("With no problems and writes held", () => {
      it('the system message is {"problem":"OFF","problem_count":0,"held":"ON"}', () => {
        expect(one(view({ held: true }), SYSTEM_STATE_TOPIC)).toBe(
          '{"problem":"OFF","problem_count":0,"held":"ON"}',
        );
      });
    });
    describe("With three problems and writes not held", () => {
      const state = view({ problems: [problem(1), problem(2), problem(3)] });
      it('the system message has problem "ON", problem_count 3 and held "OFF"', () => {
        expect(parse(one(state, SYSTEM_STATE_TOPIC))).toEqual({
          problem: "ON",
          problem_count: 3,
          held: "OFF",
        });
      });
      it("the problems message lists the three with kind, subject, name, severity and data, and more is 0", () => {
        const message = parse(one(state, PROBLEMS_TOPIC));
        expect(message.more).toBe(0);
        expect(message.problems).toHaveLength(3);
        expect(Object.keys(message.problems[0])).toEqual([
          "kind",
          "subject",
          "name",
          "severity",
          "data",
        ]);
      });
    });
    describe("With 60 problems", () => {
      const state = view({ problems: Array.from({ length: 60 }, (_, n) => problem(n)) });
      it("the problems message lists 50 and more is 10", () => {
        const message = parse(one(state, PROBLEMS_TOPIC));
        expect(message.problems).toHaveLength(50);
        expect(message.more).toBe(10);
      });
      it("problem_count is 60", () => {
        expect(parse(one(state, SYSTEM_STATE_TOPIC)).problem_count).toBe(60);
      });
    });
  });
});

/* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

// ---- the publisher against a recording stub -----------------------------------------------------

type Published = Readonly<{ topic: string; payload: string; qos: number; retain: boolean }>;
type Handler = (topic: string, payload: Buffer, retained: boolean) => void;

function stub(initial: MqttState = "connected") {
  let state: MqttState = initial;
  const published: Published[] = [];
  const filters = new Map<string, Set<Handler>>();
  const listeners = new Set<(event: MqttEvent) => void>();
  let failNext = 0;
  let gate: Promise<void> | undefined;
  const mqtt: DiscoveryMqtt = {
    state: () => state,
    async publish(topic, payload, options) {
      if (gate !== undefined) await gate;
      if (failNext > 0) {
        failNext -= 1;
        throw new Error("refused");
      }
      published.push({ topic, payload, ...options });
    },
    subscribe(filter, handler) {
      const set = filters.get(filter) ?? new Set();
      set.add(handler);
      filters.set(filter, set);
      return () => {
        set.delete(handler);
      };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    mqtt,
    published,
    filters,
    setState(next: MqttState) {
      state = next;
    },
    connect() {
      state = "connected";
      for (const listener of [...listeners]) listener({ kind: "connected", first: false });
    },
    failNext(n: number) {
      failNext = n;
    },
    hold(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
    deliver(topic: string, payload: string, retained: boolean) {
      for (const [filter, handlers] of filters) {
        const f = filter.split("/");
        const t = topic.split("/");
        if (f.length !== t.length || !f.every((l, i) => l === "+" || l === t[i])) continue;
        for (const handler of [...handlers]) handler(topic, Buffer.from(payload), retained);
      }
    },
    topics: () => published.map((m) => m.topic),
    clear() {
      published.length = 0;
    },
    subscribed: () => [...filters.entries()].filter(([, s]) => s.size > 0).map(([f]) => f),
  };
}

function make(
  mqttStub = stub(),
  stopWriting: () => Promise<unknown> = () => Promise.resolve(),
  extra: Partial<Pick<DiscoveryDeps, "roomCommand" | "roomChoice" | "log">> = {},
) {
  const discovery = createDiscovery({
    mqtt: mqttStub.mqtt,
    stopWriting,
    roomCommand: () => Promise.resolve(),
    roomChoice: () => Promise.resolve(),
    options: OPTIONS,
    log: undefined,
    ...extra,
  });
  return { discovery, stub: mqttStub };
}

const SYSTEM_CONFIG = systemConfigTopic("homeassistant");
const ROOM_A = roomConfigTopic("homeassistant", "a");
const ROOM_B = roomConfigTopic("homeassistant", "b");

describe("discovery (createDiscovery)", () => {
  describe("start", () => {
    describe("Always", () => {
      it("subscribes to homeassistant/status, to the press topic, to the room commands and to <prefix>/device/heatmaster/+/config", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        expect(s.subscribed()).toEqual([
          "homeassistant/status",
          PRESS_TOPIC,
          "heatmaster/rooms/+/set/+",
          "homeassistant/device/heatmaster/+/config",
        ]);
      });
    });
  });

  describe("sync", () => {
    describe("With a first state of two rooms, connected", () => {
      it("publishes the system config, the two room configs, then three state messages and the problems message, in that order", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        expect(s.topics()).toEqual([
          SYSTEM_CONFIG,
          ROOM_A,
          ROOM_B,
          roomStateTopic("a"),
          roomStateTopic("b"),
          SYSTEM_STATE_TOPIC,
          PROBLEMS_TOPIC,
        ]);
      });
      it("every message is retained with QoS 1", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        expect(s.published.every((m) => m.retain && m.qos === 1)).toBe(true);
      });
    });

    describe("With the same state again", () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view());
        expect(s.published).toEqual([]);
      });
    });

    describe("With one room's temperature changed", () => {
      it("publishes that room's state topic only", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ rooms: [room("a", { currentTemperature: 21 }), room("b")] }));
        expect(s.topics()).toEqual([roomStateTopic("a")]);
      });
    });

    describe("With one room renamed", () => {
      it("publishes that room's config topic only", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ rooms: [room("a", { name: "Renamed" }), room("b")] }));
        expect(s.topics()).toEqual([ROOM_A]);
      });
    });

    describe("With the language changed from en to ru", () => {
      it("publishes the system config and every room config, and no state message", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ language: "ru" }));
        expect(s.topics()).toEqual([SYSTEM_CONFIG, ROOM_A, ROOM_B]);
      });
    });

    describe('With a room gone and configState "ok"', () => {
      it("publishes an empty retained payload to its config topic and to its state topic", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ rooms: [room("a")] }));
        expect(s.published).toEqual([
          { topic: ROOM_B, payload: "", qos: 1, retain: true },
          { topic: roomStateTopic("b"), payload: "", qos: 1, retain: true },
        ]);
      });
      describe("With that state again", () => {
        it("publishes nothing more", async () => {
          const { discovery, stub: s } = make();
          await discovery.start();
          await discovery.sync(view());
          await discovery.sync(view({ rooms: [room("a")] }));
          s.clear();
          await discovery.sync(view({ rooms: [room("a")] }));
          expect(s.published).toEqual([]);
        });
      });
    });

    describe('With a retained config for room_old received at start and a state with configState "ok" that has no such room', () => {
      it("publishes an empty retained payload to room_old's config topic", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        const old = roomConfigTopic("homeassistant", "old");
        s.deliver(old, "{}", true);
        await discovery.sync(view());
        expect(s.published).toContainEqual({ topic: old, payload: "", qos: 1, retain: true });
      });
    });

    describe("With an empty message received on a room's config topic", () => {
      it("that topic is no longer known", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        const old = roomConfigTopic("homeassistant", "old");
        s.deliver(old, "{}", true);
        s.deliver(old, "", true);
        await discovery.sync(view());
        expect(s.topics()).not.toContain(old);
      });
    });

    describe('With configState "unreadable" after two rooms were published', () => {
      it("publishes nothing to any room topic", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ configState: "unreadable", rooms: [], held: true }));
        expect(s.topics().filter((t) => t.includes("room"))).toEqual([]);
      });
      it("still publishes the system state", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        await discovery.sync(view({ configState: "unreadable", rooms: [], held: true }));
        expect(s.topics()).toEqual([SYSTEM_STATE_TOPIC]);
      });
    });

    describe('With configState "empty" and a retained config for room_old received at start', () => {
      it("removes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        s.deliver(roomConfigTopic("homeassistant", "old"), "{}", true);
        await discovery.sync(view({ configState: "empty", rooms: [] }));
        expect(s.published.filter((m) => m.payload === "")).toEqual([]);
      });
    });

    describe("While the client is not connected", () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make(stub("disconnected"));
        await discovery.start();
        await discovery.sync(view());
        expect(s.published).toEqual([]);
      });
      describe("When the client connects after that", () => {
        it("publishes everything once, configs before states", async () => {
          const { discovery, stub: s } = make(stub("disconnected"));
          await discovery.start();
          await discovery.sync(view());
          s.connect();
          await vi.waitFor(() => {
            expect(s.published).toHaveLength(7);
          }, WAIT);
          expect(s.topics().slice(0, 3)).toEqual([SYSTEM_CONFIG, ROOM_A, ROOM_B]);
        });
      });
    });

    describe("With a publish that rejects", () => {
      it("the same message is published at the next sync", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        s.failNext(1);
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        await discovery.sync(view());
        quiet.mockRestore();
        expect(s.topics()).not.toContain(SYSTEM_CONFIG);
        await discovery.sync(view());
        expect(s.topics()).toContain(SYSTEM_CONFIG);
      });
    });

    describe("With a state whose messages cannot be built", () => {
      /** A language with no entity texts makes building the config messages throw. */
      const broken = (): StateView => view({ language: "xx" as StateView["language"] });
      function logged() {
        const s = stub();
        const errors: string[] = [];
        const discovery = createDiscovery({
          mqtt: s.mqtt,
          stopWriting: () => Promise.resolve(),
          roomCommand: () => Promise.resolve(),
          roomChoice: () => Promise.resolve(),
          options: OPTIONS,
          log: { error: (message) => errors.push(message), warn: () => undefined },
        });
        return { discovery, s, errors };
      }
      it("sync resolves and the error is logged", async () => {
        const { discovery, errors } = logged();
        await discovery.start();
        await expect(discovery.sync(broken())).resolves.toBeUndefined();
        expect(errors).toEqual(["discovery messages could not be built"]);
      });
      it("a resend after Home Assistant comes online does not reject either", async () => {
        const { discovery, s, errors } = logged();
        await discovery.start();
        await discovery.sync(broken());
        s.deliver("homeassistant/status", "online", false);
        await vi.waitFor(() => {
          expect(errors).toHaveLength(2);
        }, WAIT);
      });
      it("the next sync with a good state publishes", async () => {
        const { discovery, s } = logged();
        await discovery.start();
        await discovery.sync(broken());
        await discovery.sync(view());
        expect(s.topics()).toContain(SYSTEM_CONFIG);
      });
    });

    describe("With two syncs asked for while one is running", () => {
      it("one more sync runs, with the newest state", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        const open = s.hold();
        const first = discovery.sync(view());
        const second = discovery.sync(view({ rooms: [room("a", { currentTemperature: 18 })] }));
        const third = discovery.sync(view({ rooms: [room("a", { currentTemperature: 17 })] }));
        open();
        await Promise.all([first, second, third]);
        const texts = s.published.filter((m) => m.topic === roomStateTopic("a"));
        expect(
          texts.map((m) => (JSON.parse(m.payload) as { temperature: number }).temperature),
        ).toEqual([19.6, 17]);
      });
    });
  });

  describe("Home Assistant status", () => {
    describe('With "online" on homeassistant/status', () => {
      it("every config and state message is published again, configs first", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        s.deliver("homeassistant/status", "online", false);
        await vi.waitFor(() => {
          expect(s.published).toHaveLength(7);
        }, WAIT);
        expect(s.topics().slice(0, 3)).toEqual([SYSTEM_CONFIG, ROOM_A, ROOM_B]);
      });
    });
    describe('With "offline"', () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.sync(view());
        s.clear();
        s.deliver("homeassistant/status", "offline", false);
        await discovery.sync(view());
        expect(s.published).toEqual([]);
      });
    });
    describe("Before the first sync", () => {
      it("publishes nothing", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        s.deliver("homeassistant/status", "online", false);
        await Promise.resolve();
        expect(s.published).toEqual([]);
      });
    });
  });

  describe("button", () => {
    describe("With PRESS on the press topic", () => {
      it("stopWriting is called once", async () => {
        const stopWriting = vi.fn(() => Promise.resolve());
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "PRESS", false);
        expect(stopWriting).toHaveBeenCalledTimes(1);
      });
    });
    describe("With PRESS carrying the retain flag", () => {
      it("stopWriting is not called", async () => {
        const stopWriting = vi.fn(() => Promise.resolve());
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "PRESS", true);
        expect(stopWriting).not.toHaveBeenCalled();
      });
    });
    describe("With another payload", () => {
      it("stopWriting is not called", async () => {
        const stopWriting = vi.fn(() => Promise.resolve());
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "press", false);
        s.deliver(PRESS_TOPIC, "", false);
        expect(stopWriting).not.toHaveBeenCalled();
      });
    });
    describe("With stopWriting rejecting", () => {
      it("the error is logged and the next press calls it again", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const stopWriting = vi.fn(() => Promise.reject(new Error("no")));
        const { discovery, stub: s } = make(stub(), stopWriting);
        await discovery.start();
        s.deliver(PRESS_TOPIC, "PRESS", false);
        await vi.waitFor(() => {
          expect(quiet).toHaveBeenCalledTimes(1);
        }, WAIT);
        s.deliver(PRESS_TOPIC, "PRESS", false);
        expect(stopWriting).toHaveBeenCalledTimes(2);
        await vi.waitFor(() => {
          expect(quiet).toHaveBeenCalledTimes(2);
        }, WAIT);
        quiet.mockRestore();
      });
    });
  });

  describe("commands", () => {
    const SCHEDULES = [
      { id: "wd", name: "Weekdays" },
      { id: "we", name: "Weekend" },
    ];
    async function ready() {
      const roomCommand = vi.fn<(roomId: string, command: ThermostatCommand) => Promise<unknown>>(
        () => Promise.resolve(),
      );
      const roomChoice = vi.fn<(roomId: string, choice: RoomChoice) => Promise<unknown>>(() =>
        Promise.resolve(),
      );
      const warn = vi.fn();
      const log = { error: vi.fn(), warn };
      const { discovery, stub: s } = make(stub(), undefined, { roomCommand, roomChoice, log });
      await discovery.start();
      await discovery.sync(view({ rooms: [room("mancave")], schedules: SCHEDULES }));
      const send = (what: string, text: string, retained = false): void => {
        s.deliver(roomCommandTopic("mancave", what), text, retained);
      };
      const deliver = (topic: string, text: string): void => {
        s.deliver(topic, text, false);
      };
      return { discovery, roomCommand, roomChoice, warn, send, deliver };
    }

    describe('With heatmaster/rooms/mancave/set/temperature "21.5"', () => {
      it("roomCommand got mancave set_target 21.5", async () => {
        const { roomCommand, send } = await ready();
        send("temperature", "21.5");
        expect(roomCommand).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "set_target",
          celsius: 21.5,
          end: undefined,
        });
      });
    });
    describe('With set/mode "auto"', () => {
      it("roomCommand got resume", async () => {
        const { roomCommand, send } = await ready();
        send("mode", "auto");
        expect(roomCommand).toHaveBeenCalledExactlyOnceWith("mancave", { kind: "resume" });
      });
    });
    describe('With set/mode "heat"', () => {
      it("roomCommand got heat", async () => {
        const { roomCommand, send } = await ready();
        send("mode", "heat");
        expect(roomCommand).toHaveBeenCalledExactlyOnceWith("mancave", { kind: "heat" });
      });
    });
    describe('With set/mode "off"', () => {
      it("roomCommand got off with the room's default end", async () => {
        const { roomCommand, send } = await ready();
        send("mode", "off");
        expect(roomCommand).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "off",
          end: undefined,
        });
      });
    });
    describe('With set/preset "eco"', () => {
      it("roomCommand got set_preset eco", async () => {
        const { roomCommand, send } = await ready();
        send("preset", "eco");
        expect(roomCommand).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "set_preset",
          preset: "eco",
          end: undefined,
        });
      });
    });
    describe('With set/preset "none"', () => {
      it("nothing is called", async () => {
        const { roomCommand, roomChoice, warn, send } = await ready();
        send("preset", "none");
        expect(roomCommand).not.toHaveBeenCalled();
        expect(roomChoice).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      });
    });
    describe('With set/schedule "Weekdays" for an existing schedule named Weekdays', () => {
      it("roomChoice got schedule with its id", async () => {
        const { roomChoice, send } = await ready();
        send("schedule", "Weekdays");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "schedule",
          scheduleId: "wd",
        });
      });
    });
    describe('With set/override_end "Until cancelled"', () => {
      it("roomChoice got override_end manual", async () => {
        const { roomChoice, send } = await ready();
        send("override_end", "Until cancelled");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "override_end",
          rule: "manual",
        });
      });
    });
    describe("With window_enabled OFF", () => {
      it("calls roomChoice with window_enabled false", async () => {
        const { roomChoice, send } = await ready();
        send("window_enabled", "OFF");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "window_enabled",
          on: false,
        });
      });
    });
    describe("With window_temperature ON", () => {
      it("calls roomChoice with window_temperature true", async () => {
        const { roomChoice, send } = await ready();
        send("window_temperature", "ON");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "window_temperature",
          on: true,
        });
      });
    });
    describe('With window_action "Valves off"', () => {
      it("calls roomChoice with window_action off", async () => {
        const { roomChoice, send } = await ready();
        send("window_action", "Valves off");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "window_action",
          action: "off",
        });
      });
    });
    describe('With window_limit "4 h"', () => {
      it("calls roomChoice with window_limit 4 h", async () => {
        const { roomChoice, send } = await ready();
        send("window_limit", "4 h");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "window_limit",
          limitMs: 4 * 60 * 60 * 1000,
        });
      });
    });
    describe('With window_limit "none"', () => {
      it("calls roomChoice with window_limit undefined", async () => {
        const { roomChoice, send } = await ready();
        send("window_limit", "none");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "window_limit",
          limitMs: undefined,
        });
      });
    });
    describe('With window_end "Stopped falling"', () => {
      it("calls roomChoice with window_end stopped_falling", async () => {
        const { roomChoice, send } = await ready();
        send("window_end", "Stopped falling");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "window_end",
          end: "stopped_falling",
        });
      });
    });
    describe('With window_manual_change "Ignore"', () => {
      it("calls roomChoice with window_manual_change ignore", async () => {
        const { roomChoice, send } = await ready();
        send("window_manual_change", "Ignore");
        expect(roomChoice).toHaveBeenCalledExactlyOnceWith("mancave", {
          kind: "window_manual_change",
          manualChange: "ignore",
        });
      });
    });
    describe("With an unknown window option", () => {
      it("calls nothing and logs a warning", async () => {
        const { roomChoice, roomCommand, warn, send } = await ready();
        send("window_limit", "3 days");
        send("window_end", "never");
        send("window_enabled", "maybe");
        expect(roomChoice).not.toHaveBeenCalled();
        expect(roomCommand).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(3);
      });
    });
    describe("With a retained window command", () => {
      it("calls nothing", async () => {
        const { roomChoice, warn, send } = await ready();
        send("window_enabled", "OFF", true);
        expect(roomChoice).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      });
    });
    describe('With set/temperature "warm"', () => {
      it("nothing is called and one warning is logged", async () => {
        const { roomCommand, roomChoice, warn, send } = await ready();
        send("temperature", "warm");
        expect(roomCommand).not.toHaveBeenCalled();
        expect(roomChoice).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
    describe("With set/temperature empty", () => {
      it("nothing is called and one warning is logged", async () => {
        const { roomCommand, warn, send } = await ready();
        send("temperature", "");
        expect(roomCommand).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
    describe('With set/schedule "Nights", which no schedule is named', () => {
      it("nothing is called and one warning is logged", async () => {
        const { roomChoice, warn, send } = await ready();
        send("schedule", "Nights");
        expect(roomChoice).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
    describe("With a command for a room that does not exist", () => {
      it("nothing is called and one warning is logged", async () => {
        const { roomCommand, warn, deliver } = await ready();
        deliver(roomCommandTopic("ghost", "mode"), "auto");
        expect(roomCommand).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
    describe("With set/fan", () => {
      it("nothing is called and one warning is logged", async () => {
        const { roomCommand, warn, send } = await ready();
        send("fan", "high");
        expect(roomCommand).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
      });
    });
    describe("With a retained command", () => {
      it("nothing is called", async () => {
        const { roomCommand, roomChoice, warn, send } = await ready();
        send("mode", "auto", true);
        send("schedule", "Weekdays", true);
        expect(roomCommand).not.toHaveBeenCalled();
        expect(roomChoice).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      });
    });
    describe("With roomCommand rejecting", () => {
      it("one warning is logged and discovery keeps running", async () => {
        const { roomCommand, warn, send, discovery } = await ready();
        roomCommand.mockRejectedValueOnce(new Error("no"));
        send("mode", "auto");
        await vi.waitFor(() => {
          expect(warn).toHaveBeenCalledTimes(1);
        }, WAIT);
        send("mode", "heat");
        expect(roomCommand).toHaveBeenCalledTimes(2);
        await expect(discovery.sync(view({ rooms: [room("mancave")] }))).resolves.toBeUndefined();
      });
    });
  });

  describe("stop", () => {
    describe("Always", () => {
      it("the subscriptions are removed", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.stop();
        expect(s.subscribed()).toEqual([]);
      });
      it("nothing is published", async () => {
        const { discovery, stub: s } = make();
        await discovery.start();
        await discovery.stop();
        await discovery.sync(view());
        s.connect();
        expect(s.published).toEqual([]);
      });
    });
  });
});

// ---- the real client on the test broker --------------------------------------------------------

describe("discovery on the test broker (the real MQTT client)", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
  });

  async function setup(stopWriting: () => Promise<unknown>) {
    const fake: FakeZ2m = await startFakeZ2m();
    closers.push(() => fake.stop());
    const options = { url: fake.url, username: undefined, password: undefined };
    const first = createMqttClient({ ...options, clientId: undefined }, systemClock);
    await first.connect();
    closers.push(() => first.end());
    const discovery = createDiscovery({
      mqtt: first,
      stopWriting,
      roomCommand: () => Promise.resolve(),
      roomChoice: () => Promise.resolve(),
      options: OPTIONS,
      log: undefined,
    });
    await discovery.start();
    closers.push(() => discovery.stop());
    const second = createMqttClient({ ...options, clientId: "second" }, systemClock);
    return { fake, discovery, second };
  }

  describe("With a sync of one room", () => {
    it("a second client that subscribes afterwards receives the room's config and state as retained messages", async () => {
      const { discovery, second } = await setup(() => Promise.resolve());
      await discovery.sync(view({ rooms: [room("a")] }));
      await second.connect();
      closers.push(() => second.end());
      const got = new Map<string, boolean>();
      second.subscribe("homeassistant/device/heatmaster/+/config", (t, _p, retained) => {
        got.set(t, retained);
      });
      second.subscribe("heatmaster/rooms/+/state", (t, _p, retained) => {
        got.set(t, retained);
      });
      await vi.waitFor(() => {
        expect(got.get(ROOM_A)).toBe(true);
        expect(got.get(roomStateTopic("a"))).toBe(true);
      }, WAIT);
    });
  });

  describe("With a PRESS published by a second client", () => {
    it("stopWriting is called", async () => {
      const stopWriting = vi.fn(() => Promise.resolve());
      const { second } = await setup(stopWriting);
      await second.connect();
      closers.push(() => second.end());
      await second.publish(PRESS_TOPIC, "PRESS", { qos: 1, retain: false });
      await vi.waitFor(() => {
        expect(stopWriting).toHaveBeenCalledTimes(1);
      }, WAIT);
    });
  });
});
