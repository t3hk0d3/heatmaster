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

## Plan 3a (0.3.0): room thermostat, room Кабинет (2026-11-25)

Times are local (CET). The `chauffage` integration was uninstalled before the test.

- Install: the Supervisor's clone of the repository followed `plan1-foundation`, the default branch when the
  repository was added, so it never offered 0.3.0. Deleting the merged `plan1-foundation` and
  `plan2-rooms-from-ha` branches made its pull fail. The user then uninstalled the app and added the
  repository again. 0.3.0 installed as `6f549332_heatmaster`, a fresh install (log: "a fresh install: the empty
  config is saved with writes held"). The 0.2.0 data is lost, so the upgrade from 0.2.0 was not verified live.
- Config again: schedule `mancave` (18 °C, 22 °C from 07:00, 18 °C from 23:00), the default, and the room's
  sensor `ha:sensor.sensor_th_cabinet_temperature`. Without the sensor entry the config would have taken the
  `heatmaster_temp_sensor` label off and the valve to its internal sensor. The preview before the apply showed
  `sensor_source → internal` because no sensor had been read yet; after the apply it was gone.
- Originals recorded at join: external sensor, frost 7, `heat`, 22. The valve was in `heat` 22 before the
  release. Applied at 02:55 with writes held; on release the week was written again (the same values)
  and `heat → auto`; Кабинет `in_sync`, target 18, no problems. Home Assistant has
  `climate.heatmaster_mancave` and the selects "Override ends" and "Schedule".
- Climate entity: 21 °C at 03:23:27 became an override (origin `climate`, rule `next_change`, end 07:00); the
  valve showed `heat` 21 at 03:23:57. The 30 s are the 10 s pause after an override starts plus the tick.
  `auto` at 03:24:07 resumed the schedule; the valve was `auto` 18 one second later.
- Knob, valve in `auto`: one click at 03:26:22 switched the valve to `heat` at its last manual setpoint (21);
  the room became an override at 21 with origin the valve. No write followed.
- End rule: "For a set time" made the room's rule `timer` (120 min); the running override kept its 07:00
  end. 20 °C at 03:26:47 ended at 05:26:47; the valve showed 20 at 03:27:29. Resume schedule (the page's
  route) at 03:28:05: `auto` 18 two seconds later. Putting the select back wrote `override_end:
  next_change` into the room's entry instead of removing it (a known item, left for later).
- Restart: an override of 21 from the climate entity, the app stopped at 04:05:58. In `heat` the knob's
  first click only woke the display; two more set 22 (reported 04:07:14). The app started at 04:07:25 and
  wrote nothing to the valve. It did not ask the valve either: the saved request budget was 0.38 of a
  token. The valve's next report (04:18:12, after Heatmaster's push of the room temperature) made the room
  an override at 22 with origin the valve; the knob's value was never overwritten.
- Finding: after a start, a valve is not asked to report while its saved budget is empty, so a change made
  while the app was stopped waits for the valve's own next report, and the room stays `pending` until the
  first ask (a mark on a readable group clears only on an answer to an ask). The first ask went at
  04:26:25, when the budget reached one token; its answer confirmed every readable group. The week, which
  the TRVZB cannot report on request, stays marked until it is written in full, with the next token (about
  04:56); Кабинет shows `pending` until then. Fix in 0.3.1: a valve's first ask after a start needs no
  token, at most once every 30 minutes per valve. Writes keep the saved budget, so restarts cannot
  wear the valve.
- Afterwards: the override ended at 07:00 and Кабинет went back to its schedule. Later that day it was
  `in_sync`, the valve `auto` 22, no problems; since the restart one schedule write (the week sent again)
  and one thermostat write (back to `auto`).
- The window valve (TRV-ZBT) was not part of this test.
- 0.3.1 (2026-11-26): the budget of Кабинет's valve was run down to 0.1 token with four overrides from
  the climate entity. With the app stopped, a Zigbee2MQTT `/set` of setpoint 22 stood in for the knob.
  At the start (15:52:46) the valve was asked at the first tick without a token, and 2 s later the room
  was an override at 22 with origin the valve (11 minutes under 0.3.0). The week, sent again with the
  next token, keeps the room `pending` until then.
