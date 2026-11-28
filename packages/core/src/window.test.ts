import { describe, expect, it } from "vitest";
import { BUILDER_NOW, makeOpening } from "../test/builders.ts";
import { DEFAULT_WINDOW_SETTINGS } from "./model.ts";
import type { ContactRef, TemperatureDetection, WindowSettings } from "./model.ts";
import type { SensorReading } from "./temperature.ts";
import { contactVerdict, dropDetected, noteTrails, stillFor, windowStep } from "./window.ts";
import type {
  ContactReading,
  ContactVerdict,
  TrailPoint,
  Trails,
  WindowInput,
  WindowOpening,
} from "./window.ts";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const NOW_MS = BUILDER_NOW.epochMilliseconds;
const C1 = "ha:binary_sensor.c1";
const C2 = "ha:binary_sensor.c2";
const S1 = "ha:sensor.s1";
const TEMPERATURE = DEFAULT_WINDOW_SETTINGS.temperature;

// Builders --------------------------------------------------------------------------------------

/** The house's window settings with the given ones changed. */
function settingsWith(fields: Partial<WindowSettings> = {}): WindowSettings {
  return { ...DEFAULT_WINDOW_SETTINGS, ...fields };
}

/** The house's temperature detection with the given values changed. */
function temperatureWith(fields: Partial<TemperatureDetection>): WindowSettings {
  return settingsWith({ temperature: { ...TEMPERATURE, ...fields } });
}

function contactsOf(...ids: readonly string[]): readonly ContactRef[] {
  return ids.map((ref) => ({ ref }));
}

/** A contact that has shown `open` since `changedAt`, so its last known state is that one. */
function shown(open: boolean, changedAt: number): ContactReading {
  return { open, changedAt, lastOpen: open, lastAt: changedAt };
}

/** A contact unavailable since `changedAt`, last seen `lastOpen` since `lastAt`. */
function unavailable(changedAt: number, lastOpen: boolean, lastAt: number): ContactReading {
  return { open: undefined, changedAt, lastOpen, lastAt };
}

function readingsOf(entries: Record<string, ContactReading>): ReadonlyMap<string, ContactReading> {
  return new Map(Object.entries(entries));
}

function verdictOf(
  ids: readonly string[],
  entries: Record<string, ContactReading>,
  nowMs = NOW_MS,
): ContactVerdict {
  return contactVerdict(contactsOf(...ids), readingsOf(entries), DEFAULT_WINDOW_SETTINGS, nowMs);
}

/** A room verdict on its own, with no contact named. */
function verdict(state: ContactVerdict["state"], openSince?: number): ContactVerdict {
  return { state, openSince, open: [], unavailable: [] };
}

/** Midnight of an arbitrary day, so trail tests can name wall times. */
const MIDNIGHT_MS = NOW_MS - 12 * HOUR_MS;

/** The instant of an `HH:MM` wall time on that day. */
function at(time: string): number {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  return MIDNIGHT_MS + hours * HOUR_MS + minutes * MINUTE_MS;
}

function trail(...points: readonly (readonly [number, string])[]): readonly TrailPoint[] {
  return points.map(([value, time]) => ({ value, at: at(time) }));
}

function trailsOf(points: readonly TrailPoint[]): Trails {
  return new Map([[S1, points]]);
}

function sensorReading(value: number, seenAt: number): SensorReading {
  return { sensorId: S1, value, seenAt, pending: false };
}

/** Nothing seen, no drop, not frozen, no person change, the thermostat on. */
function input(fields: Partial<WindowInput> = {}): WindowInput {
  return {
    settings: DEFAULT_WINDOW_SETTINGS,
    contacts: undefined,
    drop: false,
    stillMs: 0,
    frozen: false,
    personChange: false,
    thermostatOff: false,
    ...fields,
  };
}

/** An opening held by open contacts since `startedAt`. */
function byContacts(startedAt = NOW_MS - 10 * MINUTE_MS, fields: Partial<WindowOpening> = {}) {
  return makeOpening({ startedAt, ...fields });
}

/** An opening held only by a drop that began `sinceMs` ago. */
function byTemperature(sinceMs: number, fields: Partial<WindowOpening> = {}): WindowOpening {
  return makeOpening({
    startedAt: NOW_MS - sinceMs,
    temperatureSince: NOW_MS - sinceMs,
    ...fields,
  });
}

// Tests ------------------------------------------------------------------------------------------

describe("window", () => {
  describe("contactVerdict", () => {
    describe("With one contact open for 31 s", () => {
      it("is open", () => {
        expect(verdictOf([C1], { [C1]: shown(true, NOW_MS - 31 * SECOND_MS) }).state).toBe("open");
      });
      it("names the contact as open since it opened", () => {
        const result = verdictOf([C1], { [C1]: shown(true, NOW_MS - 31 * SECOND_MS) });
        expect(result.open).toEqual([C1]);
        expect(result.openSince).toBe(NOW_MS - 31 * SECOND_MS);
      });
    });
    describe("With one contact open for 10 s", () => {
      it("is settling", () => {
        expect(verdictOf([C1], { [C1]: shown(true, NOW_MS - 10 * SECOND_MS) }).state).toBe(
          "settling",
        );
      });
    });
    describe("With two contacts, one open for a minute", () => {
      it("is open", () => {
        const result = verdictOf([C1, C2], {
          [C1]: shown(false, NOW_MS - HOUR_MS),
          [C2]: shown(true, NOW_MS - MINUTE_MS),
        });
        expect(result.state).toBe("open");
      });
    });
    describe("With every contact closed for 61 s", () => {
      it("is closed", () => {
        const result = verdictOf([C1, C2], {
          [C1]: shown(false, NOW_MS - 61 * SECOND_MS),
          [C2]: shown(false, NOW_MS - 61 * SECOND_MS),
        });
        expect(result.state).toBe("closed");
      });
    });
    describe("With a contact that went off, on, off within 100 ms and has been off for 20 s", () => {
      it("is settling", () => {
        expect(verdictOf([C1], { [C1]: shown(false, NOW_MS - 20 * SECOND_MS) }).state).toBe(
          "settling",
        );
      });
    });
    describe("With a contact that went off, on, off within 100 ms and has been off for 61 s", () => {
      it("is closed", () => {
        expect(verdictOf([C1], { [C1]: shown(false, NOW_MS - 61 * SECOND_MS) }).state).toBe(
          "closed",
        );
      });
    });
    describe("With a contact unavailable for 10 min whose last state was open since an hour ago", () => {
      it("is open", () => {
        const reading = unavailable(NOW_MS - 10 * MINUTE_MS, true, NOW_MS - HOUR_MS);
        expect(verdictOf([C1], { [C1]: reading }).state).toBe("open");
      });
    });
    describe("With a contact unavailable for 31 min", () => {
      const reading = unavailable(NOW_MS - 31 * MINUTE_MS, true, NOW_MS - HOUR_MS);
      it("is closed", () => {
        expect(verdictOf([C1], { [C1]: reading }).state).toBe("closed");
      });
      it("lists it as unavailable", () => {
        expect(verdictOf([C1], { [C1]: reading }).unavailable).toEqual([C1]);
      });
    });
    describe("With a contact last seen closed and unavailable for exactly 30 min", () => {
      it("is closed", () => {
        const reading = unavailable(NOW_MS - 30 * MINUTE_MS, false, NOW_MS - 2 * HOUR_MS);
        expect(verdictOf([C1], { [C1]: reading }).state).toBe("closed");
      });
    });
    describe("With a contact never seen", () => {
      it("is closed", () => {
        expect(verdictOf([C1], {}).state).toBe("closed");
      });
      it("does not list it as unavailable", () => {
        expect(verdictOf([C1], {}).unavailable).toEqual([]);
      });
    });
    describe("With a contact unknown for 10 min and never seen on or off", () => {
      const reading: ContactReading = {
        open: undefined,
        changedAt: NOW_MS - 10 * MINUTE_MS,
        lastOpen: undefined,
        lastAt: undefined,
      };
      it("is settling", () => {
        expect(verdictOf([C1], { [C1]: reading }).state).toBe("settling");
      });
      it("does not list it as unavailable", () => {
        expect(verdictOf([C1], { [C1]: reading }).unavailable).toEqual([]);
      });
    });
    describe("With a contact unknown for 31 min and never seen on or off", () => {
      const reading: ContactReading = {
        open: undefined,
        changedAt: NOW_MS - 31 * MINUTE_MS,
        lastOpen: undefined,
        lastAt: undefined,
      };
      it("is closed", () => {
        expect(verdictOf([C1], { [C1]: reading }).state).toBe("closed");
      });
      it("lists it as unavailable", () => {
        expect(verdictOf([C1], { [C1]: reading }).unavailable).toEqual([C1]);
      });
    });
    describe("With a contact back from unavailable showing on, changedAt 5 s ago", () => {
      it("is settling", () => {
        expect(verdictOf([C1], { [C1]: shown(true, NOW_MS - 5 * SECOND_MS) }).state).toBe(
          "settling",
        );
      });
    });
  });

  describe("noteTrails", () => {
    const keepMs = 20 * MINUTE_MS;
    const used = new Set([S1]);
    describe("With a new value", () => {
      it("appends it at the reading's seenAt", () => {
        const before = trailsOf(trail([19.3, "11:50"]));
        const readings = new Map([[S1, sensorReading(19.1, at("11:58"))]]);
        const result = noteTrails(before, readings, used, keepMs, at("12:00"));
        expect(result.get(S1)).toEqual(trail([19.3, "11:50"], [19.1, "11:58"]));
      });
    });
    describe("With the same value again", () => {
      it("appends nothing", () => {
        const before = trailsOf(trail([19.3, "11:50"]));
        const readings = new Map([[S1, sensorReading(19.3, at("11:58"))]]);
        const result = noteTrails(before, readings, used, keepMs, at("12:00"));
        expect(result.get(S1)).toEqual(trail([19.3, "11:50"]));
      });
    });
    describe("With a reading that is not used", () => {
      it("clears the sensor's trail", () => {
        const before = trailsOf(trail([19.3, "11:50"]));
        const readings = new Map([[S1, sensorReading(19.1, at("11:58"))]]);
        const result = noteTrails(before, readings, new Set(), keepMs, at("12:00"));
        expect(result.has(S1)).toBe(false);
      });
    });
    describe("With points older than keepMs", () => {
      it("keeps only the newest of them", () => {
        const before = trailsOf(
          trail([20.0, "11:00"], [19.8, "11:20"], [19.6, "11:30"], [19.4, "11:50"]),
        );
        const readings = new Map([[S1, sensorReading(19.4, at("11:50"))]]);
        const result = noteTrails(before, readings, used, keepMs, at("12:00"));
        expect(result.get(S1)).toEqual(trail([19.6, "11:30"], [19.4, "11:50"]));
      });
    });
  });

  describe("dropDetected", () => {
    describe("With 19.3 in force since 06:02 and 19.1 at 08:12, 18.9 at 08:22 (now 08:22)", () => {
      it("detects a drop", () => {
        const trails = trailsOf(trail([19.3, "06:02"], [19.1, "08:12"], [18.9, "08:22"]));
        expect(dropDetected([S1], trails, TEMPERATURE, undefined, at("08:22"))).toBe(true);
      });
    });
    describe("With 19.5 at 01:51 and 19.3 at 06:02 (now 06:02)", () => {
      it("detects none", () => {
        const trails = trailsOf(trail([19.5, "01:51"], [19.3, "06:02"]));
        expect(dropDetected([S1], trails, TEMPERATURE, undefined, at("06:02"))).toBe(false);
      });
    });
    describe("With 21.3 at 16:02, 21.1 at 16:15, 20.9 at 16:42 (now 16:42)", () => {
      it("detects none", () => {
        const trails = trailsOf(trail([21.3, "16:02"], [21.1, "16:15"], [20.9, "16:42"]));
        expect(dropDetected([S1], trails, TEMPERATURE, undefined, at("16:42"))).toBe(false);
      });
    });
    describe("With the drop's reference before notBefore", () => {
      it("detects none", () => {
        const trails = trailsOf(trail([19.3, "06:02"], [19.1, "08:12"], [18.9, "08:22"]));
        expect(dropDetected([S1], trails, TEMPERATURE, at("08:00"), at("08:22"))).toBe(false);
      });
    });
    describe("With an empty trail", () => {
      it("detects none", () => {
        expect(dropDetected([S1], new Map(), TEMPERATURE, undefined, at("08:22"))).toBe(false);
      });
    });
  });

  describe("stillFor", () => {
    describe("With the last fall 25 min ago", () => {
      it("returns 25 min", () => {
        const trails = trailsOf(trail([20.0, "11:00"], [19.6, "11:35"], [19.8, "11:50"]));
        expect(stillFor([S1], trails, at("11:00"), at("12:00"))).toBe(25 * MINUTE_MS);
      });
    });
    describe("With still 30 min, within 20 min and the trail kept for still", () => {
      it("sees a fall older than within", () => {
        const before = trailsOf(trail([20.0, "11:00"], [19.6, "11:35"]));
        const readings = new Map([[S1, sensorReading(19.6, at("11:35"))]]);
        const keepMs = Math.max(TEMPERATURE.withinMs, 30 * MINUTE_MS);
        const trails = noteTrails(before, readings, new Set([S1]), keepMs, at("12:00"));
        expect(stillFor([S1], trails, at("11:00"), at("12:00"))).toBe(25 * MINUTE_MS);
      });
    });
  });

  describe("windowStep", () => {
    describe("With no opening and contacts open", () => {
      const openSince = NOW_MS - 31 * SECOND_MS;
      const step = () =>
        windowStep(undefined, input({ contacts: verdict("open", openSince) }), NOW_MS);
      it("starts an opening at the contacts' openSince", () => {
        expect(step().opening).toEqual(makeOpening({ startedAt: openSince }));
      });
      it("holds", () => {
        expect(step().holds).toBe(true);
      });
    });
    describe("With no opening and a drop", () => {
      it("starts an opening with temperatureSince now", () => {
        const step = windowStep(undefined, input({ drop: true }), NOW_MS);
        expect(step.opening).toEqual(makeOpening({ startedAt: NOW_MS, temperatureSince: NOW_MS }));
      });
    });
    describe("With an opening held by contacts and contacts closed", () => {
      it("ends it", () => {
        const step = windowStep(byContacts(), input({ contacts: verdict("closed") }), NOW_MS);
        expect(step.opening?.endedAt).toBe(NOW_MS);
      });
    });
    describe("With an opening held by contacts and contacts settling", () => {
      it("keeps it", () => {
        const opening = byContacts();
        const step = windowStep(opening, input({ contacts: verdict("settling") }), NOW_MS);
        expect(step.opening).toEqual(opening);
      });
    });
    describe("With a temperature opening and end fixed after 30 min", () => {
      it("ends it at 30 min", () => {
        const before = windowStep(byTemperature(30 * MINUTE_MS - 1), input(), NOW_MS);
        expect(before.opening?.endedAt).toBeUndefined();
        const step = windowStep(byTemperature(30 * MINUTE_MS), input(), NOW_MS);
        expect(step.opening?.endedAt).toBe(NOW_MS);
        expect(step.opening?.temperatureEndedAt).toBe(NOW_MS);
      });
    });
    describe("With a temperature opening and end stopped_falling, still for 20 min", () => {
      it("ends it", () => {
        const settings = temperatureWith({ end: "stopped_falling" });
        const step = windowStep(
          byTemperature(25 * MINUTE_MS),
          input({ settings, stillMs: 20 * MINUTE_MS }),
          NOW_MS,
        );
        expect(step.opening?.endedAt).toBe(NOW_MS);
      });
    });
    describe("With a temperature opening ended 40 min ago and a new drop", () => {
      const opening = makeOpening({
        startedAt: NOW_MS - 80 * MINUTE_MS,
        temperatureEndedAt: NOW_MS - 40 * MINUTE_MS,
        endedAt: NOW_MS - 40 * MINUTE_MS,
      });
      const step = () => windowStep(opening, input({ drop: true }), NOW_MS);
      it("reopens the same opening", () => {
        expect(step().opening).toEqual({
          ...opening,
          endedAt: undefined,
          temperatureSince: NOW_MS,
        });
      });
      it("keeps startedAt", () => {
        expect(step().opening?.startedAt).toBe(NOW_MS - 80 * MINUTE_MS);
      });
    });
    describe("With a temperature opening ended 70 min ago", () => {
      it("drops it", () => {
        const opening = makeOpening({
          startedAt: NOW_MS - 110 * MINUTE_MS,
          temperatureEndedAt: NOW_MS - 70 * MINUTE_MS,
          endedAt: NOW_MS - 70 * MINUTE_MS,
        });
        expect(windowStep(opening, input(), NOW_MS).opening).toBeUndefined();
      });
    });
    describe("With an opening of 2 h and limit 2 h", () => {
      const opening = byContacts(NOW_MS - 2 * HOUR_MS);
      const step = (settings = DEFAULT_WINDOW_SETTINGS) =>
        windowStep(
          opening,
          input({ settings, contacts: verdict("open", opening.startedAt) }),
          NOW_MS,
        );
      it("sets limitAt", () => {
        expect(step().opening?.limitAt).toBe(NOW_MS);
      });
      it("reports limitReached", () => {
        expect(step().limitReached).toBe(true);
      });
      it("sets notifiedAt", () => {
        expect(step().opening?.notifiedAt).toBe(NOW_MS);
      });
      it("does not hold with afterLimit heat", () => {
        expect(step(settingsWith({ afterLimit: "heat" })).holds).toBe(false);
      });
      it("holds with afterLimit stay", () => {
        expect(step(settingsWith({ afterLimit: "stay" })).holds).toBe(true);
      });
    });
    describe("With the house frozen when the limit is reached", () => {
      const opening = byContacts(NOW_MS - 2 * HOUR_MS);
      const step = () =>
        windowStep(opening, input({ contacts: verdict("closed"), frozen: true }), NOW_MS);
      it("does not report limitReached", () => {
        expect(step().limitReached).toBe(false);
      });
      it("does not set notifiedAt", () => {
        expect(step().opening?.notifiedAt).toBeUndefined();
      });
    });
    describe("With an opening past its limit not yet notified, the house live again", () => {
      const opening = byContacts(NOW_MS - 3 * HOUR_MS, { limitAt: NOW_MS - HOUR_MS });
      const step = () =>
        windowStep(opening, input({ contacts: verdict("open", opening.startedAt) }), NOW_MS);
      it("reports limitReached", () => {
        expect(step().limitReached).toBe(true);
      });
      it("sets notifiedAt", () => {
        expect(step().opening?.notifiedAt).toBe(NOW_MS);
      });
    });
    describe("With an opening already notified of its limit", () => {
      it("does not report limitReached", () => {
        const opening = byContacts(NOW_MS - 3 * HOUR_MS, {
          limitAt: NOW_MS - HOUR_MS,
          notifiedAt: NOW_MS - HOUR_MS,
        });
        const step = windowStep(
          opening,
          input({ contacts: verdict("open", opening.startedAt) }),
          NOW_MS,
        );
        expect(step.limitReached).toBe(false);
      });
    });
    describe("With an opening past its limit when the contacts close", () => {
      const opening = byContacts(NOW_MS - 3 * HOUR_MS, { limitAt: NOW_MS - HOUR_MS });
      const step = () => windowStep(opening, input({ contacts: verdict("closed") }), NOW_MS);
      it("ends it", () => {
        expect(step().opening?.endedAt).toBe(NOW_MS);
      });
      it("reports dismissed", () => {
        expect(step().dismissed).toBe(true);
      });
    });
    describe("With a suspended opening reaching the limit", () => {
      const opening = byContacts(NOW_MS - 2 * HOUR_MS, { suspendedAt: NOW_MS - HOUR_MS });
      const step = () =>
        windowStep(opening, input({ contacts: verdict("open", opening.startedAt) }), NOW_MS);
      it("sets no limitAt", () => {
        expect(step().opening?.limitAt).toBeUndefined();
      });
      it("reports no limitReached", () => {
        expect(step().limitReached).toBe(false);
      });
    });
    describe("With a person's change suspending an opening as it reaches the limit", () => {
      it("sets no limitAt", () => {
        const opening = byContacts(NOW_MS - 2 * HOUR_MS);
        const step = windowStep(
          opening,
          input({ contacts: verdict("open", opening.startedAt), personChange: true }),
          NOW_MS,
        );
        expect(step.opening).toMatchObject({ suspendedAt: NOW_MS, limitAt: undefined });
      });
    });
    describe("With limit none", () => {
      it("never sets limitAt", () => {
        const opening = byContacts(NOW_MS - 24 * HOUR_MS);
        const step = windowStep(
          opening,
          input({
            settings: settingsWith({ limitMs: undefined }),
            contacts: verdict("open", opening.startedAt),
          }),
          NOW_MS,
        );
        expect(step.opening?.limitAt).toBeUndefined();
      });
    });
    describe("With notify off", () => {
      it("does not report limitReached", () => {
        const opening = byContacts(NOW_MS - 2 * HOUR_MS);
        const step = windowStep(
          opening,
          input({
            settings: settingsWith({ notify: false }),
            contacts: verdict("open", opening.startedAt),
          }),
          NOW_MS,
        );
        expect(step.limitReached).toBe(false);
      });
    });
    describe("With the thermostat off", () => {
      const step = (startedAt = NOW_MS - 10 * MINUTE_MS) =>
        windowStep(
          byContacts(startedAt),
          input({ contacts: verdict("open", startedAt), thermostatOff: true }),
          NOW_MS,
        );
      it("holds", () => {
        expect(step().holds).toBe(true);
      });
      it("does not hold the valves", () => {
        expect(step().holdsValves).toBe(false);
      });
      it("does not report limitReached", () => {
        const atLimit = step(NOW_MS - 2 * HOUR_MS);
        expect(atLimit.opening?.limitAt).toBe(NOW_MS);
        expect(atLimit.limitReached).toBe(false);
      });
    });
    describe("With a person change under resume_heating", () => {
      const opening = byContacts();
      const step = () =>
        windowStep(
          opening,
          input({
            settings: settingsWith({ manualChange: "resume_heating" }),
            contacts: verdict("open", opening.startedAt),
            personChange: true,
          }),
          NOW_MS,
        );
      it("sets suspendedAt", () => {
        expect(step().opening?.suspendedAt).toBe(NOW_MS);
      });
      it("does not hold", () => {
        expect(step().holds).toBe(false);
      });
    });
    describe("With a suspended temperature-only opening, still for 20 min", () => {
      it("ends it", () => {
        const opening = byTemperature(10 * MINUTE_MS, { suspendedAt: NOW_MS - 5 * MINUTE_MS });
        const step = windowStep(opening, input({ stillMs: 20 * MINUTE_MS }), NOW_MS);
        expect(step.opening?.endedAt).toBe(NOW_MS);
      });
    });
    describe("With window handling disabled", () => {
      const settings = settingsWith({ enabled: false });
      it("drops the opening", () => {
        const opening = byContacts();
        const step = windowStep(
          opening,
          input({ settings, contacts: verdict("open", opening.startedAt) }),
          NOW_MS,
        );
        expect(step.opening).toBeUndefined();
      });
      it("reports dismissed when it was past its limit", () => {
        const opening = byContacts(NOW_MS - 3 * HOUR_MS, { limitAt: NOW_MS - HOUR_MS });
        const step = windowStep(opening, input({ settings }), NOW_MS);
        expect(step.dismissed).toBe(true);
      });
    });
    describe("With the house frozen and contacts unknown", () => {
      const unknown = verdict("closed");
      it("keeps the opening", () => {
        const opening = byContacts();
        const step = windowStep(opening, input({ contacts: unknown, frozen: true }), NOW_MS);
        expect(step.opening).toEqual(opening);
      });
      it("still sets limitAt at the limit", () => {
        const opening = byContacts(NOW_MS - 2 * HOUR_MS);
        const step = windowStep(opening, input({ contacts: unknown, frozen: true }), NOW_MS);
        expect(step.opening?.limitAt).toBe(NOW_MS);
      });
      it("does not start an opening", () => {
        const step = windowStep(
          undefined,
          input({ contacts: unknown, drop: true, frozen: true }),
          NOW_MS,
        );
        expect(step.opening).toBeUndefined();
      });
    });
    describe("With the house frozen and a temperature opening past its fixed time", () => {
      const step = () => windowStep(byTemperature(31 * MINUTE_MS), input({ frozen: true }), NOW_MS);
      it("ends its temperature side", () => {
        expect(step().opening?.temperatureEndedAt).toBe(NOW_MS);
      });
      it("ends the opening of a room with no contacts", () => {
        expect(step().opening?.endedAt).toBe(NOW_MS);
      });
    });
    describe("With rejoin 0 and an opening ended 1 min ago", () => {
      it("keeps it", () => {
        const opening = makeOpening({
          startedAt: NOW_MS - 30 * MINUTE_MS,
          endedAt: NOW_MS - MINUTE_MS,
        });
        const step = windowStep(
          opening,
          input({ settings: temperatureWith({ rejoinMs: 0 }) }),
          NOW_MS,
        );
        expect(step.opening).toEqual(opening);
      });
    });
    describe("With rejoin 0 and a drop 1 min after a temperature end", () => {
      const opening = makeOpening({
        startedAt: NOW_MS - 40 * MINUTE_MS,
        temperatureEndedAt: NOW_MS - MINUTE_MS,
        endedAt: NOW_MS - MINUTE_MS,
      });
      const step = () =>
        windowStep(
          opening,
          input({ settings: temperatureWith({ rejoinMs: 0 }), drop: true }),
          NOW_MS,
        );
      it("starts a new opening", () => {
        expect(step().opening).toEqual(
          makeOpening({ startedAt: NOW_MS, temperatureSince: NOW_MS }),
        );
      });
      it("holds", () => {
        expect(step().holds).toBe(true);
      });
    });
    describe("With rejoin 0 and an opening ended longer ago than within and still (20 min)", () => {
      it("drops it", () => {
        const opening = makeOpening({
          startedAt: NOW_MS - HOUR_MS,
          endedAt: NOW_MS - 21 * MINUTE_MS,
        });
        const step = windowStep(
          opening,
          input({ settings: temperatureWith({ rejoinMs: 0 }) }),
          NOW_MS,
        );
        expect(step.opening).toBeUndefined();
      });
    });
    describe("With a suspended opening ended by temperature 10 min ago and a new drop", () => {
      const opening = makeOpening({
        startedAt: NOW_MS - 50 * MINUTE_MS,
        suspendedAt: NOW_MS - 40 * MINUTE_MS,
        temperatureEndedAt: NOW_MS - 10 * MINUTE_MS,
        endedAt: NOW_MS - 10 * MINUTE_MS,
      });
      const step = () => windowStep(opening, input({ drop: true }), NOW_MS);
      it("rejoins it", () => {
        expect(step().opening).toMatchObject({
          startedAt: opening.startedAt,
          endedAt: undefined,
          temperatureSince: NOW_MS,
        });
      });
      it("clears suspendedAt", () => {
        expect(step().opening?.suspendedAt).toBeUndefined();
      });
      it("holds the room", () => {
        expect(step().holds).toBe(true);
      });
    });
    describe("With an opening past its limit ended by temperature 10 min ago and a new drop", () => {
      const opening = makeOpening({
        startedAt: NOW_MS - 3 * HOUR_MS,
        limitAt: NOW_MS - HOUR_MS,
        notifiedAt: NOW_MS - HOUR_MS,
        temperatureEndedAt: NOW_MS - 10 * MINUTE_MS,
        endedAt: NOW_MS - 10 * MINUTE_MS,
      });
      const step = () => windowStep(opening, input({ drop: true }), NOW_MS);
      it("keeps limitAt", () => {
        expect(step().opening?.limitAt).toBe(NOW_MS - HOUR_MS);
      });
      it("reports the limit again", () => {
        expect(step().limitReached).toBe(true);
        expect(step().opening?.notifiedAt).toBe(NOW_MS);
      });
    });
    describe("With an opening past its limit rejoined while the room is off", () => {
      it("clears notifiedAt, so a later step reports the limit", () => {
        const opening = makeOpening({
          startedAt: NOW_MS - 3 * HOUR_MS,
          limitAt: NOW_MS - HOUR_MS,
          notifiedAt: NOW_MS - HOUR_MS,
          temperatureEndedAt: NOW_MS - 10 * MINUTE_MS,
          endedAt: NOW_MS - 10 * MINUTE_MS,
        });
        const step = windowStep(opening, input({ drop: true, thermostatOff: true }), NOW_MS);
        expect(step.opening?.notifiedAt).toBeUndefined();
      });
    });
    describe("With window handling disabled and an ended opening that had passed its limit", () => {
      it("does not report dismissed", () => {
        const opening = byContacts(NOW_MS - 3 * HOUR_MS, {
          limitAt: NOW_MS - HOUR_MS,
          endedAt: NOW_MS - MINUTE_MS,
        });
        const step = windowStep(
          opening,
          input({ settings: settingsWith({ enabled: false }) }),
          NOW_MS,
        );
        expect(step.dismissed).toBe(false);
      });
    });
  });
});
