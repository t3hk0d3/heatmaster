import { validateConfig } from "@heatmaster/core";
import type { Ledger, StoredConfig, ValveRecord } from "@heatmaster/core";

const day = [
  { time: "00:00", preset: "eco" },
  { time: "06:30", preset: "comfort" },
  { time: "22:00", temperature: 18 },
];

/** A small valid config document. */
export function rawConfig(): Record<string, unknown> {
  return {
    version: 1,
    settings: {
      external_write_interval_min: 10,
      sensor_stale_min: 30,
      hold_writes: false,
      timezone: "Europe/Amsterdam",
      language: "en",
    },
    presets: { comfort: 21, eco: 18, frost: 8, boost: 24 },
    schedules: [
      {
        id: "default",
        name: "Default week",
        default_week: {
          mon: day,
          tue: day,
          wed: day,
          thu: day,
          fri: day,
          sat: [{ time: "00:00", preset: "eco" }],
          sun: [{ time: "00:00", preset: "eco" }],
        },
      },
    ],
    rooms: [
      {
        id: "living",
        name: "Living room",
        area_id: "living_room",
        schedule_id: "default",
        valves: [{ id: "z2m:0x00124b0012345678" }],
        sensors: [{ ref: "ha:sensor.living_temperature", weight: 2 }],
        presets: { comfort: 22 },
      },
    ],
  };
}

export const SAMPLE_VALVE = "z2m:0x00124b0012345678";
export const SAMPLE_RELEASED_VALVE = "z2m:0x00124b00aaaaaaaa";

export function sampleStored(): StoredConfig {
  return {
    config: validateConfig(rawConfig()),
    revision: 3,
    releasing: new Map([[SAMPLE_RELEASED_VALVE, 1_700_000_000_000]]),
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
