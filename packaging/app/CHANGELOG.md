# Changelog

## Unreleased

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
