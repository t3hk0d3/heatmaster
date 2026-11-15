export { ConfigError, EMPTY_CONFIG, WEEKDAYS, effectivePresets, sensorId } from "./model.ts";
export type {
  Config,
  ConfigIssue,
  PresetName,
  Presets,
  Room,
  RoomPresets,
  Schedule,
  SensorRef,
  Settings,
  SetPoint,
  ValveRef,
  Week,
  Weekday,
} from "./model.ts";
export { CONFIG_VERSION, configToRaw, migrateRaw, validateConfig } from "./validation.ts";
export type {
  RawConfig,
  RawPresets,
  RawRoom,
  RawSchedule,
  RawSensor,
  RawSetPoint,
  RawSettings,
  RawWeek,
} from "./validation.ts";
export { aggregate, freshness } from "./temperature.ts";
export type { Freshness, RoomTemperature, SensorReading } from "./temperature.ts";
export { activePoint, daysEqual, fitWeek, normalizeDay, resolveWeek } from "./schedule.ts";
export type {
  ActivePoint,
  FittedWeek,
  ResolvedDay,
  ResolvedPoint,
  ResolvedWeek,
} from "./schedule.ts";
export { roundHalfUp } from "./rounding.ts";
