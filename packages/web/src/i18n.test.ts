import { describe, expect, it } from "vitest";
import { DICTIONARIES, pickLanguage, translator } from "./i18n.ts";

const places = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? "").sort();

describe("i18n", () => {
  describe("pickLanguage", () => {
    describe('With stored "ru" and browser ["en-US"]', () => {
      it("returns ru", () => {
        expect(pickLanguage("ru", ["en-US"])).toBe("ru");
      });
    });
    describe('With nothing stored and browser ["ru-RU", "en"]', () => {
      it("returns ru", () => {
        expect(pickLanguage(null, ["ru-RU", "en"])).toBe("ru");
      });
    });
    describe('With nothing stored and browser ["de", "en-GB"]', () => {
      it("returns en", () => {
        expect(pickLanguage(null, ["de", "en-GB"])).toBe("en");
      });
    });
    describe('With nothing stored and browser ["de", "ru"]', () => {
      it("returns ru", () => {
        expect(pickLanguage(null, ["de", "ru"])).toBe("ru");
      });
    });
    describe('With stored "de" and browser ["ru"]', () => {
      it("returns ru", () => {
        expect(pickLanguage("de", ["ru"])).toBe("ru");
      });
    });
    describe("With nothing stored and no browser language", () => {
      it("returns en", () => {
        expect(pickLanguage(null, [])).toBe("en");
      });
    });
  });

  describe("translator", () => {
    describe("With a text holding {name} and a param for it", () => {
      it("the place is replaced", () => {
        expect(translator("en")("problem.valve_silent", { name: "Hall" })).toBe(
          "Valve Hall is not responding",
        );
      });
    });
    describe("With no param for a place", () => {
      it("the place stays as written", () => {
        expect(translator("en")("problem.valve_silent")).toBe("Valve {name} is not responding");
        expect(translator("en")("problem.valve_silent", {})).toBe("Valve {name} is not responding");
      });
    });
    describe("With a numeric param", () => {
      it("it is put in as text", () => {
        expect(translator("en")("header.revision", { revision: 7 })).toBe(
          "Configuration revision 7",
        );
      });
    });
  });

  describe("dictionaries", () => {
    describe("Server codes that carry a data field", () => {
      it("io_failed, mqtt_refused and topic_invalid have a text in both languages", () => {
        for (const language of ["en", "ru"] as const) {
          for (const code of ["io_failed", "mqtt_refused", "topic_invalid"]) {
            expect(Object.hasOwn(DICTIONARIES[language], `error.${code}`), code).toBe(true);
          }
        }
      });
    });
    describe("The texts of the rooms from Home Assistant", () => {
      it("exist in both languages for every code set the page shows", () => {
        const keys = [
          "house.frozen.not_loaded",
          "house.frozen.link_down",
          "house.unlinked",
          "room.not_managed",
          "room.schedule",
          "pending.title",
          "pending.accept",
          "unused.title",
          "unused.hint",
          "ha_changes.title",
          "upgrade.title",
          "upgrade.dismiss",
          "config_unreadable.title",
          "config_unreadable.recover",
          "error.valve_not_pending",
          "error.schedule_in_use",
          ...["house_frozen", "ledger_unreadable", "transport_unusable"].map(
            (code) => `pending.reason.${code}`,
          ),
          ...["valve_not_observed", "originals_unreadable"].map((code) => `pending.reason.${code}`),
          ...[
            "schedule",
            "sensor_added",
            "sensor_removed",
            "sensors_imported",
            "override_end",
            "window_setting",
          ].map((kind) => `ha_changes.item.${kind}`),
          ...["no_area", "area_duplicate", "area_id_invalid"].map(
            (reason) => `upgrade.dropped.${reason}`,
          ),
          ...["no_area", "ignored_area", "not_in_ha"].map(
            (reason) => `unassigned.reason.${reason}`,
          ),
          ...[
            "legacy_label_present",
            "label_foreign",
            "ha_label_failed",
            "sensor_unlabellable",
          ].map((kind) => `problem.${kind}`),
          ...["no_area", "area_not_room", "sensor_unknown", "sensor_not_temperature"].map(
            (reason) => `problem.sensor_label_unused.${reason}`,
          ),
        ];
        for (const language of ["en", "ru"] as const) {
          for (const key of keys) {
            expect(Object.hasOwn(DICTIONARIES[language], key), `${language} ${key}`).toBe(true);
          }
        }
      });
      it("have no text for the removed accept flow", () => {
        for (const language of ["en", "ru"] as const) {
          expect(Object.hasOwn(DICTIONARIES[language], "error.valve_not_observed")).toBe(false);
          expect(Object.hasOwn(DICTIONARIES[language], "error.originals_unreadable")).toBe(false);
        }
      });
    });
    describe("The room state texts", () => {
      it("exist in both languages", () => {
        const keys = [
          "room.state.schedule",
          "room.state.override",
          "room.state.off",
          "room.state.origin",
          "room.end.next_change",
          "room.end.manual",
          "room.origin.climate",
          "room.origin.api",
          "room.resume",
          "room.reset",
          "room.reset_confirm",
          "error.state_readable",
        ];
        for (const language of ["en", "ru"] as const) {
          for (const key of keys) {
            expect(Object.hasOwn(DICTIONARIES[language], key), `${language} ${key}`).toBe(true);
          }
        }
      });
    });
    describe("en and ru", () => {
      it("have the same keys", () => {
        expect(Object.keys(DICTIONARIES.ru).sort()).toEqual(Object.keys(DICTIONARIES.en).sort());
      });
      it("have the same places in every text", () => {
        for (const [key, text] of Object.entries(DICTIONARIES.en)) {
          expect(places(DICTIONARIES.ru[key as keyof typeof DICTIONARIES.en]), key).toEqual(
            places(text),
          );
        }
      });
      it("have no empty text", () => {
        for (const language of ["en", "ru"] as const) {
          for (const [key, text] of Object.entries(DICTIONARIES[language])) {
            expect(text.trim(), `${language} ${key}`).not.toBe("");
          }
        }
      });
      it("say the pending valves are tried at least every 30 seconds, the tick", () => {
        expect(DICTIONARIES.en["pending.hint"]).toContain("30 seconds");
        expect(DICTIONARIES.ru["pending.hint"]).toContain("30 секунд");
      });
      it("say the changes from Home Assistant include the sensor import", () => {
        expect(DICTIONARIES.en["ha_changes.hint"]).toContain("room_temperature_sensor");
        expect(DICTIONARIES.ru["ha_changes.hint"]).toContain("room_temperature_sensor");
      });
    });
    describe("ru", () => {
      const ru = Object.entries(DICTIONARIES.ru);
      it("calls a valve taking its room one thing, подключение к комнате, never войти в комнату", () => {
        for (const [key, text] of ru) expect(text, key).not.toMatch(/вош[её]л|войт|входа в комнат/);
        expect(DICTIONARIES.ru["pending.title"]).toContain("подключения к комнате");
        expect(DICTIONARIES.ru["problem.valve_pending"]).toContain("подключить к комнате");
      });
      it("says the rooms are fixed, not frozen, while Home Assistant is away", () => {
        for (const key of [
          "house.frozen.not_loaded",
          "house.frozen.link_down",
          "problem.rooms_frozen",
          "pending.reason.house_frozen",
        ] as const) {
          expect(DICTIONARIES.ru[key], key).toContain("зафиксирован");
          expect(DICTIONARIES.ru[key], key).not.toContain("заморож");
        }
      });
      it("uses the grammatical forms the review asked for", () => {
        expect(DICTIONARIES.ru["unused.hint"]).toContain("на случай, если");
        expect(DICTIONARIES.ru["problem.legacy_label_present"]).toContain(
          "снимете метку room_temperature_sensor с датчиков",
        );
        expect(DICTIONARIES.ru["label_op.labelArea"]).toBe("назначение метки зоне");
        expect(DICTIONARIES.ru["label_op.labelEntity"]).toBe("назначение метки датчику");
      });
    });
  });
});
