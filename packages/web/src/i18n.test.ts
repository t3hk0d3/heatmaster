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
    });
  });
});
