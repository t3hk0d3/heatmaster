import { validateConfig } from "@heatmaster/core";
import type { Ledger, StoredConfig, ValveRecord } from "@heatmaster/core";

const WEEK = [
  {
    days: "weekdays",
    temperature: { "00:00": "eco", "06:30": "comfort", "22:00": 18 },
  },
  { days: "weekend", temperature: { "00:00": "eco" } },
];

const SETTINGS = {
  external_write_interval_min: 10,
  sensor_stale_min: 30,
  hold_writes: false,
  timezone: "Europe/Amsterdam",
  language: "en",
};

const PRESETS = { comfort: 21, eco: 18, frost: 8, boost: 24 };

/** A small valid version 3 config document: two schedules, two room entries. */
export function rawConfig(): Record<string, unknown> {
  return {
    version: 3,
    settings: SETTINGS,
    presets: PRESETS,
    schedules: [
      { id: "default", name: "Default week", week: WEEK },
      { id: "away", name: "Away", week: WEEK },
    ],
    default_schedule: "default",
    rooms: {
      living_room: {
        sensors: [{ ref: "ha:sensor.living_temperature", weight: 2 }],
        presets: { comfort: 22 },
      },
      office: { schedule: "away" },
    },
  };
}

export const SAMPLE_VALVE = "z2m:0x00124b0012345678";
export const SAMPLE_RELEASED_VALVE = "z2m:0x00124b00aaaaaaaa";

/** A full version 3 stored config: a membership, an HA change and an upgrade report. */
export function sampleStored(): StoredConfig {
  return {
    config: validateConfig(rawConfig()),
    revision: 3,
    releasing: new Map([[SAMPLE_RELEASED_VALVE, 1_700_000_000_000]]),
    membership: {
      rooms: new Map([
        ["living_room", { name: "Living room", valveIds: [SAMPLE_VALVE] }],
        ["office", { name: "Office", valveIds: ["z2m:0x00124b0000000009"] }],
      ]),
      ignored: ["garage"],
    },
    importedAreas: ["living_room", "office"],
    haChanges: [
      {
        revision: 2,
        at: 1_700_000_050_000,
        items: [
          {
            kind: "schedule",
            areaId: "office",
            entityId: undefined,
            scheduleId: "away",
          },
          {
            kind: "sensor_added",
            areaId: "living_room",
            entityId: "sensor.living_temperature",
            scheduleId: undefined,
          },
        ],
      },
    ],
    upgrade: {
      fromVersion: 2,
      droppedRooms: [
        { roomId: "attic", name: "Attic", valveIds: ["z2m:0x00124b0000000007"], reason: "no_area" },
      ],
    },
  };
}

/**
 * What the version 1 and version 2 house fixtures become on load: their one room is the area
 * `living_room`, writes are held, no area has had its sensor import, and the report is empty.
 */
export function convertedStored(): StoredConfig {
  const config = validateConfig({
    version: 3,
    settings: { ...SETTINGS, hold_writes: true },
    presets: PRESETS,
    schedules: [{ id: "default", name: "Default week", week: WEEK }],
    default_schedule: "default",
    rooms: {
      living_room: {
        sensors: [{ ref: "ha:sensor.living_temperature", weight: 2 }],
        presets: { comfort: 22 },
      },
    },
  });
  return {
    config,
    revision: 3,
    releasing: new Map([[SAMPLE_RELEASED_VALVE, 1_700_000_000_000]]),
    membership: {
      rooms: new Map([["living_room", { name: "Living room", valveIds: [SAMPLE_VALVE] }]]),
      ignored: [],
    },
    importedAreas: [],
    haChanges: [],
    upgrade: { fromVersion: 2, droppedRooms: [] },
  };
}

export function record(
  valveId: string,
  originals: ValveRecord["originals"] = { active_group: 1, sensor_source: "internal" },
  profile = "sonoff_trv_zbt",
): ValveRecord {
  return { valveId, profile, adoptedAt: 1_700_000_000_000, originals };
}

/** One record with a null original, one with real ones, and one released record. */
export function sampleLedger(): Ledger {
  return {
    records: new Map([
      [SAMPLE_VALVE, record(SAMPLE_VALVE)],
      [
        "z2m:0x00124b0000000002",
        record("z2m:0x00124b0000000002", { sensor_source: null }, "sonoff_trvzb"),
      ],
    ]),
    released: [
      {
        record: record(SAMPLE_RELEASED_VALVE, { sensor_source: "external" }, "sonoff_trvzb"),
        endedAt: 1_700_000_100_000,
        forgotten: false,
      },
    ],
  };
}

/** A ledger with `count` records and no released entry. */
export function ledgerWith(count: number): Ledger {
  const records = new Map<string, ValveRecord>();
  for (let i = 1; i <= count; i += 1) {
    const id = `z2m:0x00124b00000000${String(i).padStart(2, "0")}`;
    records.set(id, record(id));
  }
  return { records, released: [] };
}

/** Only released entries. */
export function releasedOnly(): Ledger {
  return { records: new Map(), released: sampleLedger().released };
}
