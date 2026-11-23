# Heatmaster

Manages Sonoff radiator valves (TRVZB, TRV-ZBT) through Zigbee2MQTT: shared schedules, weighted
room temperatures, a thermostat for each room with temporary changes, and every problem shown in its
own web page and in Home Assistant.

## What Heatmaster is

Heatmaster runs the week's schedule on each valve itself (onboard) and feeds each valve a weighted
room temperature taken from the room's sensors in Home Assistant. Since 0.3.0 each room is also one
thermostat, and Heatmaster sets the valves' mode (see [The room thermostat](#the-room-thermostat)).
Every problem it detects is
shown on its page and as Home Assistant entities. It runs as a Home Assistant app (add-on) or as a
plain container.

**Home Assistant decides which rooms exist and which valves are in them.** Heatmaster's config
keeps what Home Assistant has no notion of: the schedules, which schedule a room uses, its sensors
with their weights, and its presets. See [Rooms come from Home Assistant](#rooms-come-from-home-assistant).

It needs Zigbee2MQTT with the **`last_seen` option on**. Without it no valve is managed, and the
page says why.

## Install as an app

1. Home Assistant with Supervisor 2026.08.0 or newer, and the Mosquitto broker app installed and
   started.
2. Add this repository to the app store: `https://github.com/t3hk0d3/heatmaster`.
3. Install Heatmaster and start it.
4. Open "Heatmaster" in the sidebar. Only administrators can open it: the Supervisor refuses the
   ingress of an app with `panel_admin` to every other user.

The app takes the broker's address and login from the Supervisor, and reaches Home Assistant
through the Supervisor's proxy. Its two options, the Zigbee2MQTT base topic and the MQTT discovery
prefix, are left at their defaults unless you changed them in Zigbee2MQTT or Home Assistant.

## Install as a plain container

Use [packaging/docker-compose.yml](packaging/docker-compose.yml). Its comments carry the notes:

- Make the password hash with `caddy hash-password`, and write every `$` of it as `$$` in the file.
- Never publish ports 8099 or 3000.
- Never run the container with host networking: the API on 127.0.0.1:3000 has no login and would
  be open to every process on the host.
- Never attach the container to a network in which another container can take the address
  172.30.32.2: the ingress listener admits that address without a password.
- Put TLS in front when the page is reached from outside the home network.

The page is on port 8080, behind the login (`UI_USER`, `UI_PASSWORD_HASH`). With neither variable
set the listener is off. The variables are `MQTT_URL` (`mqtt://` or `mqtts://` only, no login
inside it), `MQTT_USERNAME`, `MQTT_PASSWORD`, `HA_URL` and `HA_TOKEN` (both or neither), and the
optional `Z2M_BASE_TOPIC`, `DISCOVERY_PREFIX`, `DATA_DIR` (default `/data`), `PUBLIC_DIR` (default
`/config`) and `HEATMASTER_PORT`. Bad values end the container with exit code 78 and a line for
each fault. Without a Home Assistant link the config must name `timezone`; a config without one
is refused. The link is also required to manage any room: see
[Rooms come from Home Assistant](#rooms-come-from-home-assistant).

**The token must belong to an administrator.** Heatmaster writes labels (see [Labels](#labels)),
and Home Assistant refuses label writes from a token whose user is not an administrator. With any
other token rooms still work, but every label write fails and a problem says so. The app gets an
administrator's rights from the Supervisor; only a plain container needs this care.

## Rooms come from Home Assistant

A **room** is a Home Assistant area that holds at least one supported valve. A room's valves are
the supported valves whose Home Assistant device is in that area. Its id is the area's id
(`area_id`), and its name is the area's name. An area with only sensors is not a room.

- **Opt out:** put the label `heatmaster_ignore` on an area. Its valves are given back (released)
  and it is no longer a room. Heatmaster only reads this label and never creates it.
- **No Apply for rooms.** A new room joins, and a change to a managed room (a valve moved in or
  out, a renamed area, a schedule or a sensor changed through a label) is written by itself, a few
  seconds after Home Assistant reports it. Several edits in a burst count as one change.
- **A valve that is not in a room** is listed under "Other valves" with the reason: its
  device has no area, its area carries `heatmaster_ignore`, or Home Assistant has no device for it
  (Zigbee2MQTT's Home Assistant discovery is off, or the device was deleted). A valve that Home
  Assistant has no device for stays in its previous room and shows a problem; it is never
  released for that. When Zigbee2MQTT does not list it either (the valve was removed), the page
  offers **Forget** for it: its record is dropped and it leaves the room.
- **A valve that cannot join yet waits as pending** and is tried again every tick (30 seconds). The page lists
  it with the reason (not yet reported, cannot be reached, the saved originals cannot be read).
  One pending valve never holds up another valve or room.
- **While Home Assistant is down,** or not yet loaded after a start, rooms are frozen on the last
  membership Heatmaster saved: no valve joins or leaves a room, while schedules and temperature
  pushes go on as usual. The page and a problem say so.
- **The Home Assistant link is required.** Without `HA_URL` and `HA_TOKEN` no room is managed and
  a problem says so; the server still starts.
- **With no schedule in the config nothing is managed:** no joins, no releases, no label writes or
  pulls. The rooms are listed and a problem asks for a schedule.

## The room thermostat

Since 0.3.0 each room behaves as one thermostat, as in the tado app. Heatmaster now **sets the
mode** of every valve it manages (`auto`, `heat` or `off`); earlier versions never did.

### Room states

A room is always in one of three states:

- **Schedule.** The room follows its week. The valves are in `auto` and run the week they hold.
- **Override.** The room is held at one temperature, until an end rule ends it. The valves are in
  `heat` at that temperature.
- **Off.** The valves are in `off`; a valve's own frost protection keeps it above its frost
  temperature. It ends by the same rules as an override.

When an override or off ends, Heatmaster writes `auto` and the valves take the schedule's current
value. **Every override is held in `heat`, whatever its end rule.** If Heatmaster is down when an
override should end, the valves stay at the override's temperature until it is running again; an
override that has already run out is ended at once at the next start.

A new override replaces the current one. A command that repeats the current state (same target and
same end rule) changes nothing, and its end time is not moved. A target is limited to the room's
range: the narrowest setpoint range of its valves (TRVZB 4 to 35 °C, TRV-ZBT 5 to 30 °C).

### End rules

| Rule          | Ends                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next_change` | At the first point of the room's week that is more than 10 minutes away. A change made 2 minutes before a point lasts until the one after it. If that point has the same target, the override still ends there. |
| `timer`       | After a set time.                                                                                                                                                                                               |
| `manual`      | Never; the room stays as set until it is resumed ("until you cancel").                                                                                                                                          |

The house default is `next_change`, and a timed change lasts 120 minutes. Both can be set for the
house and for one room in the config; a duration is whole minutes from 15 to 1440 (24 hours):

```yaml
settings:
  override_end: next_change # next_change, timer or manual; the default
  override_duration_min: 120 # 15 to 1440; the default
rooms:
  bedroom:
    override_end: timer
    override_duration_min: 60
```

A room's entry wins over `settings`. A change may also carry its own rule and duration, through the
API (below). **A boost** is an override at the `boost` preset (23 °C unless you changed it) for 30
minutes, whatever the room's rule. Presets (`comfort` 20, `eco` 17, `frost` 7, `boost` 23) are
those of the config, for the house and per room; an override may name one or give a temperature.

### Where a change can be made

- **A valve.** Turn the knob or press the button: Heatmaster takes it as the room's new state, with
  the room's end rule, and brings the room's other valves to match. See [Changes made on a
  valve](#changes-made-on-a-valve).
- **The room's `climate` entity in Home Assistant** (below).
- **The API.** `POST /api/rooms/<id>/override` with `{"target": 21}` or `{"preset": "eco"}` and an
  optional `"end": {"rule": "timer", "durationMs": 3600000}`; `DELETE /api/rooms/<id>/override`
  returns the room to its schedule; `POST /api/rooms/<id>/off` turns it off (it takes `end` too).
  `durationMs` is whole minutes in milliseconds, 15 minutes to 24 hours.
- **The page.** Each room shows its state ("Following the schedule", "Set to 21 °C until the next
  schedule change", "Off until …"), where the change was made, and a "Resume schedule" button.

A change made in one place shows in all the others. The page can only resume the schedule; it does
not set a target.

### The climate entity and the two selects

Each room's device in Home Assistant gets, with MQTT discovery:

- **`climate.heatmaster_<room id>`** ("Thermostat"). Its `current_temperature` is the room's
  temperature and its `temperature` the current target. `hvac_mode` is `auto` on the schedule,
  `heat` in an override and `off` when off. Setting `auto` resumes the schedule, `off` turns the room
  off, and `heat` starts an override at the current target. Setting a temperature or a preset
  (`comfort`, `eco`, `frost`, `boost`; `none` when there is none) starts an override with the
  room's end rule; `boost` lasts 30 minutes. The range is the room's, in steps of 0.5 °C. Its
  attributes are `rule`, `ends_at`, `origin` (a valve's name, `climate` or `api`), `next_change_at`
  and `next_target`.
- **`select.heatmaster_<room id>_override_end`** ("Override ends"): "Next schedule change", "For a
  set time" or "Until cancelled". It sets the room's end rule, which is a change of the config
  (a new revision), so choosing it just before setting a temperature picks the rule for that
  change.
- **`select.heatmaster_<room id>_schedule`** ("Schedule"): the schedule's name. It is a config
  change too, and the area's schedule label follows it (see [Labels](#labels)).

(A room's id has `-` replaced by `_` in entity ids.) The valves' own Home Assistant entities from
Zigbee2MQTT are left alone; a change made on them is taken like a knob.

### Changes made on a valve

Heatmaster writes a valve, then reads its reports until the valve shows what was written. That is
how a write is **confirmed**. After that, a report that neither the confirmed state nor a write
still waiting for its confirmation explains is a person's change, and becomes the room's state:

- mode `off`: the room is off;
- mode `auto` on a valve that was confirmed in another mode: the room returns to its schedule;
- a setpoint: an override at that target;
- mode `heat` with no new setpoint: an override at the room's current target.

If several valves change in one tick, the newest report wins. A write that never matches is a
communication failure, not a person's change: it is retried, and a "setting not holding" problem is
shown. Heatmaster never undoes a change made on a valve or in Home Assistant.

The two models behave differently, so the rules differ:

- **TRVZB.** The knob's first click switches the valve to `heat` at its last manual setpoint, and
  more clicks change it; turning below 4 °C switches it to `off`. In `auto` its setpoint is not
  judged (the valve moves it itself at schedule points), so a person shows as a change of mode.
- **TRV-ZBT.** The knob changes the setpoint and the valve stays in `auto`; the top button toggles
  `auto` and `heat`. On its schedule, a setpoint that is any value of the valve's own week is the
  valve's doing; any other value is a person's. Heatmaster keeps the week a state was confirmed
  under, so a restart does not make the valve's week unknown.
- In `heat`, which is only used by an override, the setpoint must match exactly on both models.

**The 10-second settle.** After an override or off starts, from any source, no mode or setpoint is
written to any of the room's valves for 10 seconds, so a knob turned several clicks, or a slider
dragged, costs each valve one write. A return to the schedule is written at once.

A write that fails on one valve does not stop the others. A valve that cannot be reached gets the
room's state when it next reports, and the room shows as not in sync until then.

**Known limits.** These are the cases Heatmaster cannot tell from its own writes:

- A TRV-ZBT on its schedule turned to a value of its own week changes only that valve until its next
  point. Turned while a changed week is not yet confirmed on it, it is set back once the week is
  confirmed.
- A person who sets a valve to exactly the value Heatmaster sent less than a minute earlier is not
  seen.
- A report that shows a write of the last minute in only one of its two parts is judged on the
  valve's next report.
- Pressing `heat` at a valve without changing its setpoint, while a `heat` write to it is waiting
  for its confirmation, is taken for that write.
- A Heatmaster write that lands more than a minute late may be taken for a person's change.
- A TRV-ZBT turned back to the value that was in force before Heatmaster's `heat` write landed is
  not seen.
- A combined write whose setpoint is lost just as the valve passes a schedule point is taken for a
  person's change.
- **A lost, queued or late TRV-ZBT schedule write.** The valve's days cannot be read back, so a write
  that is lost or late while the valve still reports counts as confirmed. The valve then stays on its
  old week while Heatmaster takes the new one. The next point of the old week, if its value is not in
  the new week, is taken for a person's change: the room goes into an override at that value until its
  end rule ends it. Resuming the schedule puts it right.
- Heatmaster cannot tell a knob from a write sent through Zigbee2MQTT or Home Assistant. Both show
  as a change made on that valve.

### Taking over a valve

A valve that Heatmaster has not seen confirm a state for its room is **taken over**: nothing it
shows is adopted, and it is written what the room wants (`auto` on its schedule). That is what
happens when a valve joins a room, when a valve moves to another room, when a valve is managed
again after its release began, at the first start of 0.3.0, and after Start over. So a room that
joins always starts on its schedule, whatever mode its valves were left in.

### Frost protection

Heatmaster writes each managed valve's `frost_protection_temperature`: the room's `frost` preset
(7 °C unless changed), limited to the valve's range (TRVZB 4 to 35, TRV-ZBT 5 to 15 °C).

### `state.json` and Start over

The room states, and for each valve the state Heatmaster saw it confirm and the writes sent since,
are kept in `state.json` in `/data`. A missing file means every room is on its schedule and every
valve is taken over. A change made on a valve is saved before any valve is written for it, so a
failed save is tried again with the same report on the next tick, and meanwhile no mode or setpoint
is written; schedules, temperature pushes and frost protection go on.

If `state.json` cannot be read, Heatmaster writes **no mode or setpoint to any valve** and judges
nothing, and a problem says so. It does not overwrite the file. The page then offers **Start over**
(`POST /api/thermostats/reset`): the unreadable file is set aside, an empty state is saved, every
room goes back to its schedule and every valve is taken over. Start over is refused while the file
can be read.

## Example config

```yaml
version: 3
settings:
  timezone: Europe/Amsterdam
  hold_writes: true
schedules:
  - id: main
    name: Main
    week:
      - days: weekdays
        temperature:
          "00:00": 16
          "06:30": 20
          "22:00": 16
      - days: weekend
        temperature:
          "00:00": 16
          "08:00": comfort
          "23:00": 16
  - id: away
    name: Away
    week:
      - days: all
        temperature:
          "00:00": 14
default_schedule: main
rooms:
  living_room:
    sensors:
      - ref: ha:sensor.living_temperature
        weight: 2
      - ref: ha:sensor.shelf_temperature
  bedroom:
    schedule: away
```

The keys of `rooms` are Home Assistant area ids. A room with no entry, or no `schedule`, uses
`default_schedule`; a room with no `sensors` runs its valves on their own sensor, with no push and
no problem. A sensor's `weight` is above 0 and at most 10, and 1 when left out. There is no valve
list anywhere. An entry for an area that is not a room (yet) is kept and shown as unused; an area
may get a valve later. A schedule that a room uses cannot be deleted.

Documents of version 2 are refused (`version_unsupported` at path `version`); a stored config of
version 1 or 2 is converted when it is loaded, see [Upgrading from 0.1](#upgrading-from-01).

A schedule's `week` is a list of blocks, applied in order; every weekday must be in at least one block. A
later block replaces the whole day plan of each day it names, so `all` followed by `[fri]` gives
friday its own plan; a block whose days are all overridden later is refused. `days` is a list
of day names (`[mon, wed]`), or one of `all`, `weekdays` (mon to fri) and `weekend` (sat, sun).
`temperature` maps each time, in quotes, to a temperature or a preset name, and holds `"00:00"`.
Documents of version 1 (a `default_week` with a list per day) are refused too.

Home Assistant gets, through MQTT discovery, one device per room (temperature, target
temperature, problem and sync entities) and one "Heatmaster" device (problem, problem count,
writes held, and the "Stop writing" button). The room device also holds the room's thermostat and
two selects, see [The room thermostat](#the-room-thermostat).
Their entity ids are `<platform>.heatmaster_<room id>_<kind>` (for example
`sensor.heatmaster_living_room_temperature`); this needs Home Assistant 2025.10 or newer, which
reads the discovery key `default_entity_id`. Older releases ignore it and name the entities from
their names.

## First run

1. The page shows the rooms Home Assistant gives (and the valves in no room), and whether each
   valve has reported yet.
2. Write the config: the schedules and a `default_schedule`. A new config holds writes unless it
   says otherwise (`hold_writes`). The first start of a fresh install holds writes too, so no valve
   is written before you have seen every room. Labels are still mirrored and the one-time sensor
   import still runs while writes are held, because they are not valve writes.
3. Preview: check the valves that join, their captured originals and the planned writes. The
   captured originals are what Zigbee2MQTT's cache held at that moment; a preview asks each
   joining valve to report, so preview once more before applying if a value looks wrong.
4. Apply. No valve is written yet; Heatmaster only asks the valves to report.
5. Check the rooms, the problems and the diagnostics.
6. Press "Release writes".

This is the only confirmation Heatmaster asks for. After it, rooms and their changes follow Home
Assistant with no Apply.

## Labels

Heatmaster keeps these Home Assistant labels in step with its config, in both directions, while it
runs.

| Label                      | On            | Meaning                                                                                                                |
| -------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `heatmaster_ignore`        | area          | The area is no room. Read only; you create and set it.                                                                 |
| `heatmaster_schedule_<id>` | area          | The area's room uses schedule `<id>` (a `-` in the id becomes `_`). Named "Heatmaster: <name>". Heatmaster creates it. |
| `heatmaster_temp_sensor`   | sensor entity | The entity is a temperature sensor of its room.                                                                        |
| `room_temperature_sensor`  | sensor entity | Your own automation's label. Read once per room by the sensor import, never written.                                   |

**Config to Home Assistant.** Heatmaster creates one label per schedule (it creates the name
`heatmaster_schedule_<id>`, then renames it to "Heatmaster: <name>"), puts the room's schedule label
on each room's area (a room on the default schedule wears the default's label too, so your
automations see every room's schedule), and puts `heatmaster_temp_sensor` on every sensor any
`rooms` entry lists (unused entries too), and takes it off sensors no entry lists. It adopts an existing label with the right id, and
removes the labels of schedules that no longer exist.

**Home Assistant to config.** A label edit made while Heatmaster runs becomes a config revision,
listed on the page as "changed in Home Assistant", newest first (the last 20 are kept):

- Moving a schedule label onto an area, or changing which one it wears, changes the room's
  schedule. Taking the schedule label off an area, with none left, puts the room back on
  `default_schedule`. With two schedule labels on one area the newest wins and the other is removed.
- Adding `heatmaster_temp_sensor` to a sensor puts it in the room of its own area, else its
  device's area, with weight 1. Removing the label takes the sensor out of every room that lists
  it. If the area is not a room, or the sensor fails the checks (not a temperature sensor, belongs
  to a valve, unknown to Home Assistant, the room has 16 sensors already), the label stays and a
  problem names the sensor; no room changes.

A label edit that would need a config entry the config cannot hold (more than 64 entries, or an
area id that is not 1 to 64 lowercase letters, digits and underscores) changes nothing, and a
problem says so; the sensor import leaves such a room out the same way. The next mirror may put the
labels back as the config has them.

Heatmaster's own label writes never come back as revisions.

**The config wins at start and at every reconnect to Home Assistant.** Labels are set to match it,
so a label edit made while Heatmaster was not connected is undone.

**Heatmaster owns every label whose id starts with `heatmaster_schedule_`,** and touches no other
label except the `heatmaster_temp_sensor` assignments. A label `heatmaster_schedule_<id>_<n>` (for
instance the `_2` Home Assistant adds when a name is taken) is treated as foreign: a problem names
it, and it is never deleted.

A failed label write shows a problem and never blocks valve control; each label command times out
after 10 seconds.

Known limits:

- **No compare-and-set.** Home Assistant cannot make a label write conditional. A user edit to an
  area's or sensor's labels that lands between Heatmaster's reload of the registries and its write
  is overwritten.
- **Home Assistant stops answering just after a write.** A user edit to one of that write's
  targets may be reverted until the first settle after Home Assistant answers again.
- **Two Home Assistant stalls within a few seconds.** If Home Assistant stops answering twice in a
  row, once at the end of a label write and once for a reload just after it, a late echo of
  Heatmaster's own write can be read as your edit: a room's schedule assignment may go back to the
  older config. It shows as a "changed in Home Assistant" revision, which you can undo by applying
  the config again.
- **A label edit just before a mirror.** A label edit made in the 5 seconds before Heatmaster
  writes the labels (after an apply, at a reconnect, after a room change, or right after another
  write) is not taken: the labels are set back to the config.
- **A sensor a room already lists.** A `heatmaster_temp_sensor` label on a sensor that a room
  already lists is ignored, so it cannot move the sensor into another room. To move a sensor
  between rooms, edit the config.
- **Schedule ids** may not end in `-<digits>` or `_<digits>` (`schedule_id_reserved`), and two ids
  that differ only by `-` and `_` are refused (`label_id_duplicate`). Numbered
  `heatmaster_schedule_*_<n>` labels are never touched.
- **With no schedule in the config nothing is managed:** no label writes, no pulls.

## Upgrading from 0.1

Version 0.2 reads a stored config of version 1 or 2 and converts it to version 3:

- Each old room's `area_id` becomes its key under `rooms`. An old room with no `area_id`, one whose
  area another room already uses, or one with an invalid area id cannot be kept. The page shows
  "Configuration converted" with each dropped room, its valves and the reason, until you dismiss it.
- Before the first save, the old file is kept as `config.v<old>.json` (for example
  `config.v2.json`) beside `config.json` in `/data`. It is never replaced.
- Room ids become area ids. A room whose old id differed from its area's gets new Home Assistant
  entity ids (`<platform>.heatmaster_<area id>_<kind>`); the old ones stay in Home Assistant until
  deleted there.
- **The first start after a conversion is held** (no valve is written; labels are still mirrored and
  the sensor import still runs), like a fresh install, because it may adopt valves
  you left out on purpose. Look at the rooms, then press "Release writes" once.
- A valve managed under the old config that ends in no room is released: its original sensor
  source and active group are written back.
- If the converted config breaks a rule of the new format, Heatmaster manages no room, leaves every
  valve alone, and the page says how to recover; `config.json` is not changed.

**Sensors, once per room.** The first time a room exists while Home Assistant is loaded (on a
fresh install, after a conversion, or when a room appears later, for example once Zigbee2MQTT lists
its valve), Heatmaster fills it, if it has no sensors, from the entities in its area labelled
`room_temperature_sensor` (the entity's area, else its device's area), with weight 1. The page
lists these as "changed in Home Assistant". Each room gets this once; afterwards only
`heatmaster_temp_sensor` counts for it.

**Handing a room over from your own automation.** If an automation of yours feeds the valves from
`room_temperature_sensor`, it keeps doing so: Heatmaster does not touch that label, and two
writers would fight. A problem ("still carry room_temperature_sensor") names each room where both
exist. Once Heatmaster has pushed a temperature to a room's valves for the first time, remove
`room_temperature_sensor` from that room's sensors, or turn the automation off for the room.
Nothing else needs to change: the sensors keep their `heatmaster_temp_sensor` label.

## Upgrading to 0.3.0

- Heatmaster now writes valve modes. Valves are in `auto` while a room follows its schedule, and
  in `heat` or `off` while it is overridden or off.
- The first start of 0.3.0 has no `state.json`: every room is on its schedule and every valve is
  taken over, so a valve left in `heat` or `off`, or at a held setpoint, is put back to `auto`.
- **Valves joined before 0.3.0 keep their mode, setpoint and frost protection on release.** Their
  records hold no such originals, and they are not changed afterwards. Valves that join from 0.3.0
  on get them given back.
- Heatmaster treats an outside write, such as an automation that sets a valve's setpoint, as a
  person's change: it becomes the room's override. The room's `origin` says which valve it was.
- The problem `valve_not_auto` is gone: Heatmaster sets the mode, so a valve not in `auto` is
  no longer reported.

## Pending valves

A valve that is in a room but fails a join check is listed under "Valves waiting to join a room"
with its reason, and is tried again every tick (30 seconds). Most reasons clear by themselves.

The exception is unknown originals: some of the valve's current settings cannot be read, so they
cannot be saved and given back later. Heatmaster never accepts that by itself. Press "Accept
unknown originals" on that valve to take it over anyway, knowing that those settings cannot be
restored when it leaves. Without it the valve stays pending, unwritten.

## What Heatmaster does to a valve

It overwrites the valve's schedule, and sends it again at every start, after a rejoin, after a
Zigbee2MQTT restart and once a day. **The valve's old schedule is not saved and not put back.**
The sensor source (and on TRV-ZBT the active group) is saved and put back on release. Since 0.3.0
it also sets the valve's mode and setpoint to follow the room's state, and its frost protection.
**The valve's `system_mode`, setpoint and frost protection** are saved when it joins and put back
on release, with one exception: **the setpoint is put back only when the original mode was `heat`**,
because a setpoint written to a TRVZB in `auto` would switch it to `heat`.

Heatmaster limits how often it writes to a valve: a bucket of 6 writes per valve, one more every 30
minutes. The time the bucket is full again is kept in `/data/pacing.json`, so a restart, or a
restart loop, does not refill it. If that file cannot be read, every valve starts with an empty
bucket and the page shows a problem.

TRV-ZBT: Heatmaster uses schedule group 3 and does not save what it held. A valve whose active
group is already 3 can join; its group 3 is overwritten. After a release the active group is back;
Zigbee2MQTT's "group to edit" stays 3.

## Rollback

Give the valves back by putting the label `heatmaster_ignore` on each of their areas in Home
Assistant, with writes released. Wait until no valve is listed as releasing, and until the rooms
are gone from the page. Then uninstall. (Applying a config with no rooms no longer does this: rooms
come from Home Assistant, not from the config.)

## What uninstall deletes and keeps

- `/data` (the config, `config.v<old>.json` copies, the saved originals and `pacing.json`) is
  deleted.
- The public folder (`/config`) with `originals.json` and its four older copies stays.
- The devices in Home Assistant stay until they are deleted there.
- The labels `heatmaster_schedule_*` and `heatmaster_temp_sensor` stay on their areas and sensors
  until you remove them in Home Assistant.
- A valve that was not released keeps Heatmaster's schedule and falls back to its own sensor when
  the temperature stops coming.

## When a file cannot be read

An unreadable config freezes every valve; apply a config with the overwrite switch, and the old
file is kept beside the new one.

**While the config cannot be saved** (a full or read-only disk), every tick that must save a room
change (a valve joins or leaves a room, a release is ordered or ends) stops after the failed save:
no valve write and no temperature push goes out in that tick, for any room, and a problem says the
config could not be saved. Valves keep their last set point and fall back to their own sensor once
the pushed temperature is stale. Free the disk and the next tick goes on. An unreadable ledger: "Import saved originals" takes the newest
readable copy from the public folder. After a reinstall the same button brings back the originals
of valves that were not released; until it is pressed no valve can join. Originals that are not
wanted are forgotten afterwards, valve by valve.

## One instance only

Two Heatmasters on one broker would both write. The one started last wins; the other stops writing
and says so. The instance that stopped stays stopped until it is restarted, also after the other
one is gone; `/api/health` answers 503 and the page says so, and its valves get no temperature. The container stays healthy on purpose: a watchdog restart would let it take the broker session back, write the valves again and fight the other instance. Three broker
restarts within 30 seconds look the same to Heatmaster and stop it too; restart Heatmaster after
such an outage. On an MQTT 3.1.1 broker this count of dropped connections is the only sign of a
second instance, so an MQTT 5 broker, which names a takeover, is recommended.

## The broker is trusted

Anyone who can publish on the MQTT broker can change what Heatmaster believes about the valves and
can stop it. Give the broker a login and keep it off untrusted networks. A wrong MQTT password is
tried again only every 30 seconds, and the page names it.

No MQTT fault makes the container unhealthy (a broker that is down, a refused login, a second
instance): the server keeps trying by itself or stays stopped for good, and a restart would not
help or would do harm. Only a server that does not answer does. The page and `GET /api/health` (503,
code `mqtt_fault`) show it.

## When the app halts

If the server fails five times within 15 minutes the container stops (exit code 1). Under Docker's
restart policy, or with the app's Watchdog switch on, it is started again and halts again at once
until 15 minutes have passed since the first of the five starts. The valves then lose the
temperature feed and fall back to their own sensor. The app's log says why; `DOCS.md` carries the
same line and says where the log is.

## Stop writing

The "Stop writing" button in Home Assistant holds all writes. It cannot release the valves:
releasing needs the page, because it needs a look at what each valve will get back.

## Time zone

Zigbee2MQTT's host must have the right time zone, because the valves take their clock from it.

## Development

A pnpm workspace: `packages/core` (pure decision logic), `packages/server` (the shell) and
`packages/web` (the web page). Conventions are in [STYLEGUIDE.md](STYLEGUIDE.md).

```
pnpm install
pnpm check   # lint, types, tests
pnpm build   # the web page, into packages/web/dist/
```

Requires Node 26 and pnpm (see `packageManager` in `package.json`).
