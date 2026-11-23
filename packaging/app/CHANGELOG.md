# Changelog

## 0.3.0

- Each room is one thermostat with a state: following its schedule, an override, or off. Heatmaster now sets
  the valves' mode: `auto` on the schedule, `heat` at the target for every override, `off` for a room that is off.
  A valve left in an override stays in `heat` while Heatmaster is down, and an override that ran out in the
  meantime ends at the next start.
- An override ends by a rule: at the next schedule change (the default), after a set time (`timer`, 120 minutes by
  default, 15 minutes to 24 hours) or never (`manual`). Config keys `override_end` and `override_duration_min`
  in `settings` and in a room's entry. A boost is the `boost` preset for 30 minutes.
- A change made on a valve (knob or button), on the room's climate entity or through the API becomes the room's
  state, and the room's other valves follow. A write is confirmed by reading it back; a later difference that no
  expected state explains is a person's change. The rules differ for the TRVZB and the TRV-ZBT. After an
  override or off starts, no mode or setpoint is written to the room for 10 seconds. A repeated command with
  the same target and rule does not move its end. The known limits are in the README, including a lost or late
  TRV-ZBT schedule write that can show up as a phantom override.
- A valve that joins a room, moves to another, or is managed again after its release began is taken over: it is
  written what the room wants, and what it showed before is not adopted. So is every valve at the first start of
  0.3.0 and after Start over.
- Home Assistant gets a `climate.heatmaster_<room id>` entity per room (`auto`, `heat`, `off`; presets `comfort`,
  `eco`, `frost`, `boost`), and two selects: "Override ends" and "Schedule".
- Frost protection is written on every managed valve: the room's `frost` preset, limited to the valve's range.
- The page shows each room's state, where it came from and a "Resume schedule" button.
  API: `POST` and `DELETE /api/rooms/<id>/override`, `POST /api/rooms/<id>/off`, `POST /api/thermostats/reset`.
- Room states and what each valve was seen to confirm are kept in `state.json`. If it cannot be read, no mode or
  setpoint is written to any valve and the page offers Start over.
- Release gives back a valve's mode and frost protection, and its setpoint only when the original mode was
  `heat`. **Valves joined before 0.3.0 keep their mode, setpoint and frost protection on release.**
- The problem `valve_not_auto` is removed.

## 0.2.0

- Rooms come from Home Assistant: every area that holds a supported valve is a room (the label `heatmaster_ignore` opts an
  area out). New rooms join, and changes to managed rooms are written, with no Apply. Config document version 3: a
  `default_schedule` and `rooms` keyed by area id, with no valve lists. A stored version 1 or 2 config is converted
  (the old file is kept as `config.v<old>.json`), and the first start after it holds writes.
- Heatmaster keeps schedule labels (`heatmaster_schedule_<id>`) on areas and `heatmaster_temp_sensor` on sensors in step with
  its config, both ways; edits made in Home Assistant show as "changed in Home Assistant". A plain container's token must
  belong to an administrator.
- A valve that cannot join waits as pending and never holds up other valves; unknown originals are accepted only by
  pressing "Accept unknown originals". While Home Assistant is down, rooms are frozen on the last known areas.
- Each room, once, takes its sensors from `room_temperature_sensor` when it first exists, also a room that joins
  later. A valve that both Home Assistant and Zigbee2MQTT lost can be forgotten from the page.
- Rollback is now: label the areas `heatmaster_ignore`.

## 0.1.1

- A schedule's week is written as blocks of days: `days` is a list of day names or `all`, `weekdays` or `weekend`,
  and `temperature` maps times to temperatures. Config document version 2; a saved version 1 config is converted.
- The write budget is kept across restarts (`pacing.json`), so a restart loop cannot exceed it.
- A release ordered while the clock ran fast starts at once.
- Home Assistant entities have explicit names and stable ids (`sensor.heatmaster_<room>_temperature`, …).
- An "Ask to report" from the page counts toward the 2 s spacing between requests to one valve.

## 0.1.0

- First version: rooms, shared schedules, weighted room temperatures and original sensor settings for Sonoff TRVZB and TRV-ZBT valves through Zigbee2MQTT.
