# Changelog

## 0.1.1

- A schedule's week is written as blocks of days: `days` is a list of day names or `all`, `weekdays` or `weekend`,
  and `temperature` maps times to temperatures. Config document version 2; a saved version 1 config is converted.
- The write budget is kept across restarts (`pacing.json`), so a restart loop cannot exceed it.
- A release ordered while the clock ran fast starts at once.
- Home Assistant entities have explicit names and stable ids (`sensor.heatmaster_<room>_temperature`, …).
- An "Ask to report" from the page counts toward the 2 s spacing between requests to one valve.

## 0.1.0

- First version: rooms, shared schedules, weighted room temperatures and original sensor settings for Sonoff TRVZB and TRV-ZBT valves through Zigbee2MQTT.
