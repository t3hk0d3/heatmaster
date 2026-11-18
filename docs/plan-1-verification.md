# Plan 1 live verification

Heatmaster 0.1.0 (`ghcr.io/t3hk0d3/heatmaster:0.1.0`) on the user's Home Assistant, installed as an app from
`https://github.com/t3hk0d3/heatmaster#plan1-foundation`. Writes are counted from a recording of `zigbee2mqtt/#`
(the house's own automation also publishes `…/set/external_temperature_input` every 5 minutes; those are not Heatmaster's).

## Step 1: publish and install, nothing configured (2026-11-16)

- Tag `v0.1.0` pushed; the release workflow passed (container test, amd64 + arm64 image). The image is public:
  an anonymous pull works, so the Supervisor needs no registry login.
- Home Assistant has the "Heatmaster" device with four entities: problem (off), problems (0), writes held (off),
  stop writing. No room device.
- Zigbee2MQTT's log: no `/set` from Heatmaster. Seven `/get` (20:35:56–20:36:16 UTC), one per valve, all from the
  user pressing "Ask to report" on the page; none sent by Heatmaster on its own.
- Finding (minor): the problem entity has no explicit name, so Home Assistant names it in its own language
  ("Heatmaster Проблема") while the other three are English. Fix: give it a name like the others.

## Steps 2–3: preview and apply with writes held, room Кабинет (TRVZB `heating/mancave`, battery 92%)

- Preview, then Apply about a second later (20:42 UTC). Applied: HA gained the room device (temperature 21.3,
  target 19, problem, sync `held`); "writes held" on. No `/set` from Heatmaster.
- `/get` for the valve: 20:42:01.065 (the preview's ask) and 20:42:02.169 (the tick's refresh after the apply). The
  apply's own ask was refused by the one-a-minute limit, as planned.
- Finding (minor): direct asks are not known to the core's pacing, so the tick's refresh went 1.1 s after the
  preview's ask, under the 2 s spacing between requests to one valve.
- Finding (minor): room entity ids are doubled (`sensor.kabinet_kabinet_*`), and entities without an explicit
  name take Home Assistant's language ("Температура", "Проблема") beside English ones ("Target temperature", "Sync").
- Problem `valve_not_auto`: the valve is in `heat` (manual, set point 22 by hand). Every valve in the house runs
  manual `heat`; the on-valve weeks are unused. Correct by design (Heatmaster does not change the mode).
  User decision: change the room's week to 22 °C from 07:00 to 23:00 (16 °C at night), then switch the valve to `auto`.

## Plan 2 (0.2.0): rooms from Home Assistant, room Кабинет (2026-11-17/18)

- Before the update every area except Кабинет's (`mancave`) was labelled `heatmaster_ignore`. The update to 0.2.0
  converted the stored version 2 config (log: `config converted`, `fromVersion` 2) and started with writes held.
- Labels mirrored: `heatmaster_schedule_mancave` ("Heatmaster: Mancave") on the area, `heatmaster_temp_sensor` on
  `sensor.sensor_th_cabinet_temperature` (imported from `room_temperature_sensor`). The one problem was
  `legacy_label_present` for Кабинет.
- Handover: `room_temperature_sensor` removed from the sensor; the problem cleared. The user released writes;
  Кабинет went `in_sync`. The valve was switched to `auto` from Home Assistant; `valve_not_auto` cleared, no problems.
- In `auto` the valve holds Heatmaster's target (18 °C at night). Push: the sensor changed to 19.9 at 00:28:43 and the
  valve's external temperature followed at 00:28:45, with the user's automation no longer feeding this room.
- Open: the other areas join one at a time by removing `heatmaster_ignore` (live rollout).
