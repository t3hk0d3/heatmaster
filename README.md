# Heatmaster

Manages Sonoff radiator valves (TRVZB, TRV-ZBT) through Zigbee2MQTT: shared schedules, weighted
room temperatures, and every problem shown in its own web page and in Home Assistant.

## What Heatmaster is

Heatmaster runs the week's schedule on each valve itself (onboard) and feeds each valve a weighted
room temperature taken from the room's sensors in Home Assistant. Every problem it detects is
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
writes held, and the "Stop writing" button). There is no thermostat entity in this version.
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
automations see every room's schedule), and puts `heatmaster_temp_sensor` on every sensor a room
lists, and takes it off sensors no room lists. It adopts an existing label with the right id, and
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
The sensor source (and on TRV-ZBT the active group) is saved and put back on release.

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
file is kept beside the new one. An unreadable ledger: "Import saved originals" takes the newest
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
