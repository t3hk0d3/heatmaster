# Device notes: measured valve behaviour

Measured on 2026-11-15 and later, on the user's house (plan 1, Task 2).
All reads and writes go over MQTT: Home Assistant's `mqtt.publish`, and a recorder subscribed to `zigbee2mqtt/#`.

Test valves:

| Friendly name | Model | Firmware | Notes |
|---|---|---|---|
| `heating/mancave` | TRVZB | 1.4.4 (OTA 5124), date code 20251229 | |
| `heating/living-room/window` | TRV-ZBT | 1.1.3 (OTA 4355) | Replaces `heating/entrance` (TRV-ZBT 1.1.0), which has been offline since 2026-11-13 21:42 and did not answer a `get`. |

## Findings for implementers

Short list; the sections below hold the measurements. Fixtures: `packages/core/test/fixtures/z2m/` (names and IEEE addresses replaced; `test/trvzb`, `test/trv_zbt`).

1. **Fresh `last_seen` is the only proof the valve spoke.** Z2M replays cached state with the old `last_seen` after its own restart, after an HA birth message, and as the echo of a TRV-ZBT day write. Every key in a replay is cache. A write took when a message shows the desired value *and* a `last_seen` newer than any seen before the write.
2. **Writes land in 0.35–2.6 s** (fresh report). Time out a write after 120 s, not less. All writes during M2 landed.
3. **Activation is `none` on both models.** A new schedule takes effect within ~20 s (TRVZB acts up to ~40 s late, TRV-ZBT ~1 s); no mode toggle is needed.
4. **Setpoint written in auto:** TRVZB switches to `heat`; TRV-ZBT stays in `auto` and holds until the next schedule point. Never write a setpoint to a TRVZB that should stay in auto.
5. **TRV-ZBT days are write-only.** Messages after a `schedule_group_to_edit` change carry the previous group's cached days with a fresh `last_seen`, so day keys cannot be trusted as group readback. Write groups via `schedule_group_to_edit`; the valve runs `schedule_active_group` (switch shows within ~1.2 s and applies at once). Edit group survives a Z2M restart (cache).
6. **TRVZB days have no `get`** (access 3); a day `get` is ignored. TRV-ZBT day `get` yields 7 messages.
7. **`get` answers in 0.13–15.8 s** with the whole cached state and a fresh `last_seen`; asking two keys can yield two messages.
8. **Seven identical days in one message become one radio command** (`scheduleGroup`, day mask 127). Send whole weeks in one message.
9. **Unchanged `external_temperature_input` is still written to the radio** each time; pushes keep valves reporting every ≤5.2 min (≤11.2 min without pushes).
10. **External sensor fallback after ~2 h** without a push (`remote_source_offline`); the valve returns to `remote_temperature` by itself on the next push (3.8 s).
11. **Room sensors through HA only.** Sensor gaps up to 47 min; staleness 120 min; liveness is the newest `last_reported` of any entity on the sensor's HA device.
12. **Z2M restart:** `bridge/state` offline → online (35 s here), availability online for each device ~3 s later, then one replay per device. **HA restart:** `bridge/state online` with no preceding offline, plus a replay burst of every device; not a Z2M restart.
13. **Retained messages:** only bridge topics and `<name>/availability` are retained. Per-device `retain` is configurable; turning it off leaves the old retained message until an empty retained payload clears it.
14. **Ranges:** setpoint TRVZB 4–35, TRV-ZBT 5–30. Sensor select values: `local_temperature`, `remote_temperature`, `remote_source_offline`.
15. **Unexplained writes exist:** something in HA wrote `occupied_heating_setpoint` 17 to both valves at 14:17 and 14:19 UTC (source unknown). Heatmaster must expect outside writes and correct them.
16. **Not measured (skipped):** writes/`get` to an unpowered valve, rejoin after a short power loss. 24 h announce count: pending until the recording ends (2026-11-16 ~12:05 UTC).
17. **Echo confirmation (M14):**
    - the first message after a write has a fresh `last_seen` and the old state; the echo with the new value repeats that `last_seen`;
    - `last_seen` is truncated to the second, so compare a report against the write time floored to the second;
    - every mode or setpoint write showed in full within 14.6 s, under `SENT_RETIRE_MS` (60 s).
18. **Half-applied states (M14).** They last under 1 s; the TRVZB shows the mode first, the TRV-ZBT the setpoint first. On a TRV-ZBT, `{auto, X}` from `heat` can briefly show `heat <schedule value>`.
19. **TRVZB `heat` falls back (M12, M14).** `heat` without a setpoint, or before the setpoint lands, shows the **last manual heat setpoint**, not the value shown in `auto`. A combined `{heat, X}` can show `heat <last manual>` for up to 14 s.
20. **Mode writes (M12):**
    - `auto` takes the schedule's value within 2 s on both models (simulator: about 2 s, not 20 s);
    - `off` reports setpoint = frost protection;
    - a TRVZB day write leaves `heat` and `off` unchanged.
21. **Knob (M11, M12):**
    - TRVZB: the first click switches to `heat` with the last manual setpoint, and later clicks change it; turning below 4 switches to `off`;
    - TRV-ZBT: the knob changes the setpoint and the valve stays in `auto` (held); the top button toggles `auto` and `heat`;
    - reports arrive 2–3 s apart while turning, so wait for a quiet spell before taking the value;
    - a locked valve (`child_lock: LOCK`) ignores the knob and buttons.
22. **TRV-ZBT holds (M15).** `{auto, X}` holds X. `auto` again drops it. A day write does not drop it.
23. **Rejoin (M16):**
    - both models kept their week;
    - the TRV-ZBT fell back to `local_temperature` until the next sensor push;
    - Heatmaster's rejoin re-send can fail mid-rejoin (ZCL error);
    - whether a valve changes its mode by itself after a rejoin is not settled.
24. **Outside writers.** The chauffage integration writes `…/set/occupied_heating_setpoint` (likely also the source of item 15). Heatmaster must treat these writes as a person's change.
25. **TRVZB timer mode (M10).** It works from `auto`, stays in `auto` and ends by itself. The TRVZB has no boost button and no timer at the valve.

## Restore cards

Recorded on 2026-11-15 at 13:05–13:09 local time (CET), before any test write.
Restore by publishing these values to `zigbee2mqtt/<friendly name>/set`.
Heatmaster never keeps a valve's schedule, so these cards are the only copy.

### `heating/mancave` (TRVZB)

| Key | Value |
|---|---|
| `system_mode` | `heat` |
| `occupied_heating_setpoint` | `17` |
| `temperature_sensor_select` | `remote_temperature` |
| `open_window` | `OFF` |
| `frost_protection_temperature` | `7` |
| `child_lock` | `LOCK` |
| `weekly_schedule_monday` | `00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16` |
| `weekly_schedule_tuesday` | `00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16` |
| `weekly_schedule_wednesday` | `00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16` |
| `weekly_schedule_thursday` | `00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16` |
| `weekly_schedule_friday` | `00:00/16 07:00/19 10:00/16 10:00/16 17:00/19 23:00/16` |
| `weekly_schedule_saturday` | `00:00/16 07:00/19 10:00/19 10:00/19 10:00/19 23:00/16` |
| `weekly_schedule_sunday` | `00:00/16 07:00/19 10:00/19 10:00/19 10:00/19 23:00/16` |

The TRVZB day values come from Zigbee2MQTT's cache: the TRVZB days have no `get` access, so they cannot be read back from the valve.

### `heating/living-room/window` (TRV-ZBT)

| Key | Value |
|---|---|
| `system_mode` | `heat` |
| `occupied_heating_setpoint` | `17` |
| `temperature_sensor_select` | `remote_temperature` |
| `open_window` | `ON` |
| `frost_protection_temperature` | `5` |
| `child_lock` | `LOCK` |
| `schedule_active_group` | `1` |
| `schedule_group_to_edit` | `1` |
| all 7 days, groups 1, 2 and 3 | `00:00/16 06:00/19 09:00/16 16:00/19 22:00/16 22:00/16 22:00/16 22:00/16 22:00/16 22:00/16 22:00/16 22:00/16` |

The group 2 and 3 values were read by setting `schedule_group_to_edit` to 2 and then 3. After each change the valve sent about 7 device messages, one per second, all carrying the same days as group 1. The group to edit was then set back to 1.

## M0: Zigbee2MQTT and the device definitions

Read from the retained `zigbee2mqtt/bridge/info` and `zigbee2mqtt/bridge/devices` on 2026-11-15.

- Zigbee2MQTT **2.14.3** (coordinator ZStack3x0). Base topic `zigbee2mqtt`.
- `advanced.last_seen`: `ISO_8601_local` (e.g. `2026-11-15T13:05:01+01:00`). `cache_state`: true. `output`: json. `legacy_api`: false. `device_options.legacy`: false.
- Availability is enabled (active timeout 10 min, passive 1500 min). Each device has a retained `<base>/<name>/availability` topic with `{"state":"online"|"offline"}`.
- Retained topics: only `bridge/{info,state,devices,groups,definitions,extensions,converters,health}` and the per-device `availability` topics. **Device state topics are not retained.**

Access bits are 1 = published, 2 = set, 4 = get.

| Key | TRVZB access | TRV-ZBT access | Range / values |
|---|---|---|---|
| `occupied_heating_setpoint` | 7 | 7 | TRVZB 4–35, TRV-ZBT 5–30, step 0.5 |
| `local_temperature` | 5 | 5 | |
| `local_temperature_calibration` | 7 | 7 | TRVZB ±12.7, TRV-ZBT ±10, step 0.2 |
| `system_mode` | 7 | 7 | `off`, `auto`, `heat` |
| `running_state` | 5 | 5 | `idle`, `heat` |
| `battery` | 1 | 5 | 0–100 |
| `temperature_sensor_select` | 7 | 7 | `local_temperature`, `remote_temperature`, `remote_source_offline` |
| `external_temperature_input` | 7 | 7 | 0–99.9 |
| `weekly_schedule_<day>` (7 keys, `monday` … `sunday`) | **3 (no get)** | 7 | text `HH:MM/T` entries: 6 on TRVZB, 12 on TRV-ZBT |
| `schedule_active_group` | — | 7 | `1`, `2`, `3` (strings) |
| `schedule_group_to_edit` | — | 7 | `1`, `2`, `3` (strings) |
| `open_window` | 7 | 7 | |
| `frost_protection_temperature` | 7 | 7 | TRVZB 4–35, TRV-ZBT 5–15 |
| `child_lock` | 7 | 7 | |

The TRV-ZBT definition also has `remote_setpoint_temperature`, `remote_temperature_linkage`, `temporary_mode_*`, `heating_valve_position`, `idle_valve_position`, `fault_status`, `low_battery_valve_state` and `heat_percentage_hour`. The TRVZB definition has `temporary_mode_select`, `timer_mode_target_temp`, `valve_opening_degree` and `valve_closing_degree`.

## Observations during the measurements

All times are UTC in the recorder and local time (CET, +01:00) in `last_seen`.

- **Write echo.** After a `set`, Zigbee2MQTT publishes the device topic with the new value within about 1 s. For the TRVZB Sunday day and `system_mode`, the echo carried a new `last_seen`. For the TRV-ZBT `schedule_group_to_edit`, the first echo carried the **old** `last_seen` (13:05:01, when the write was at 13:08:02). The valve's own messages followed 1–2 s later with a new `last_seen`.
- **TRV-ZBT group to edit.** After `schedule_group_to_edit` changed, the valve sent about 7 device messages, one per second, each with a fresh `last_seen` and the day keys unchanged. All three groups held the same week, so the messages alone do not show which group the days belong to; M4 tests this with a distinct day.
- **M1, TRVZB, auto.** With `system_mode` set to `auto`, the target went from 17 to the schedule's current point (19) in the same second. Publishing Sunday with the current point at 20: the echo came 1 s later, and the target became 20 about **20 s after the write**, with no other action. **Activation: `none`.**
- **M1, TRVZB, setpoint in auto.** Writing `occupied_heating_setpoint: 18` while in `auto` set the target to 18 and **switched `system_mode` to `heat` in the same second**. A setpoint written in `auto` does not hold until the next point; the valve leaves `auto`.
- **M1, TRV-ZBT, auto.** With `system_mode` `auto`, the target went from 17 to the current point (16) in the same second. Publishing Sunday (group 1, active and edit group) with the current point at 17: the echo came at once with the **old** `last_seen` (13:10:37 for a write at 13:10:40); 2 s later a message carried `weekly_schedule_status: "success"` with a new `last_seen`, and the target became 17 in the same second. **Activation: `none`.** Re-publishing a day whose current point is unchanged did not move the target.
- **M1, TRV-ZBT, setpoint in auto.** `occupied_heating_setpoint: 18` in `auto` set the target to 18 and the valve **stayed in `auto`**. The setpoint held until the next point (13:18), where the target became that point's value (19).
- **M8, clock.** TRVZB: a point at 13:16 took effect at 13:16:37 (`last_seen` of the message). TRV-ZBT: a point at 13:18 took effect at 13:18:01. Both clocks are within about 40 s of local time.

## M2: write to published value

Script-driven, 2026-11-15 12:18–12:28 UTC. Each key was written 6 times (alternating values, ending on the original), 15 s apart. "Echo" is the first device message showing the written value. "Fresh" is the first such message with a `last_seen` newer than before the write.

| Valve | Key | Echo (ms) | Echo had new `last_seen` | Fresh (ms), shortest–longest |
|---|---|---|---|---|
| TRVZB | `weekly_schedule_monday` | 349–1530 | yes, 6/6 | 349–1530 |
| TRV-ZBT | `weekly_schedule_monday` | 34–137 | **no, 0/6** | 858–2018 |
| TRVZB | `temperature_sensor_select` | 404–2606 | yes, 6/6 | 404–2606 |
| TRV-ZBT | `temperature_sensor_select` | 954–1508 | yes, 6/6 | 954–1508 |
| TRVZB | `external_temperature_input` | 359–1918 | yes, 6/6 | 359–1918 |
| TRV-ZBT | `external_temperature_input` | 988–1173 | yes, 6/6 | 988–1173 |

- **Write to published value: shortest 0.35 s, longest 2.6 s** (fresh `last_seen`). All are far under the 2 min first backoff step.
- On the TRV-ZBT, a day write is echoed by Zigbee2MQTT within about 0.1 s with the **old** `last_seen`, before the valve answers. The valve's answer follows 0.9–2.0 s later with a new `last_seen` and `weekly_schedule_status: "success"`. The days in that answer are the written ones. A day value on a message with an unchanged `last_seen` therefore proves nothing; a later message with a new `last_seen` does.
- On the TRVZB, every echo of a write carried a new `last_seen`.
- Every written value appeared on the device topic. None was lost.

## M4: TRV-ZBT group writes

- One message `{"schedule_group_to_edit":"3","weekly_schedule_monday":"<12 distinct entries>"}` at 12:28:57 UTC: the active group stayed `1`, the target stayed 19, and the mode stayed `auto`. Setting the edit group back to `1` showed group 1's Monday unchanged, so **the days went to group 3**, not group 1.
- After the edit group changes, the valve reports the edit group's days over about 9 s, one message per second, starting about 3 s after the change.
- **Stop rule hit: a message cannot tie its day values to a group by itself.** After `schedule_group_to_edit` was set back to `1` (12:29:23), two messages carried `schedule_group_to_edit: "1"` together with **group 3's** Monday from Zigbee2MQTT's cache. The first had the old `last_seen`; the second (12:29:26) had a **new** `last_seen`. Group 1's real Monday arrived only at 12:29:27. Decoding days by the edit group named in the same message would have stored group 3's Monday as group 1's.
- Group 3's Monday still holds the test value; it is restored in Step 3.
- **Decision (user, 2026-11-15):** TRV-ZBT days are treated as write-only. Heatmaster never decodes them from device messages, the same as the TRVZB.
- **Active group 3** (`schedule_active_group: "3"` at 14:28:09 UTC): shown 1.2 s later with a new `last_seen`. The target did not change at once; it stayed at a manual 17 that had been set at the valve at 15:19 local. After a 15:33 point (18) was written to group 3's Sunday, the target became 18 at 15:33:21. **The valve follows the active group.**
- **Back to active group 1** (14:33:25): shown 0.6 s later, and the target moved to group 1's current point (19) in the same second.
- The edit group is left at `3` for the Zigbee2MQTT restart check in M3.

## M5: external temperature

- The user's automation pushes through Home Assistant's `number` entity. That publishes to the per-key topic `zigbee2mqtt/<name>/set/external_temperature_input` with a bare value (e.g. `18.6`), every 5 minutes, even when the value is unchanged.
- **An unchanged push reaches the valve.** Three pushes of the same 18.6 (14:20, 14:25, 14:30 UTC) each produced a device message 2.2–2.6 s later with a new `last_seen`. The radio write itself was not counted (no debug log).
- Fallback test (mancave): the `room_temperature_sensor` label was removed from `sensor.sensor_th_cabinet_temperature` at 14:34 UTC. The last push before that was at 14:30:00 UTC.
- The automation also writes `temperature_sensor_select: remote_temperature` (per-key topic) to any valve not on the remote source. During M2 it did so at 12:25:00, in the middle of the test.

## Writes from outside the tests

At 14:17:00 and 14:19:00 UTC, Home Assistant published `occupied_heating_setpoint: 17` to mancave and to the window valve on the per-key topic `…/set/occupied_heating_setpoint`. Mancave, which was in `auto`, switched to `heat`. These writes were not part of the tests, and their source has not been identified yet.

## M7: reading on demand

Script-driven, 2026-11-15 14:29–15:28 UTC: 5 rounds, about 13 minutes apart. Each `get` was `{"<key>": ""}` on `zigbee2mqtt/<name>/get`, and messages were counted for 15 s after it.

| Model | Key(s) | Answered | Time to answer, shortest–longest | Device messages in 15 s |
|---|---|---|---|---|
| TRVZB | `system_mode` | 5/5 | 0.38–15.8 s | 0–1 |
| TRVZB | `occupied_heating_setpoint` | 5/5 | 0.17–3.1 s | 1–3 |
| TRVZB | `temperature_sensor_select` | 5/5 | 0.42–14.7 s | 1 |
| TRVZB | `weekly_schedule_monday` | **0/5** | none in 20 s | 0 |
| TRVZB | `system_mode` + `temperature_sensor_select` | 5/5 | 0.50–2.0 s | 2 |
| TRV-ZBT | `system_mode` | 5/5 | 0.22–2.7 s | 1 |
| TRV-ZBT | `occupied_heating_setpoint` | 5/5 | 0.29–2.1 s | 1–2 |
| TRV-ZBT | `temperature_sensor_select` | 5/5 | 0.13–1.9 s | 1–4 |
| TRV-ZBT | `schedule_active_group` | 5/5 | 0.36–2.0 s | 1–7 |
| TRV-ZBT | `weekly_schedule_monday` | 5/5 | 0.47–2.2 s | **7** |
| TRV-ZBT | `system_mode` + `temperature_sensor_select` | 5/5 | 0.39–14.6 s | 1–4 |

- **Answers: shortest 0.13 s, longest 15.8 s.** Both are under the 2 min first backoff step.
- Every answer is the **whole cached state** (30 keys TRVZB, 43 keys TRV-ZBT) with a **new `last_seen`**. There is no request id and no reply of its own; the answer is an ordinary device message.
- Two keys in one `get` usually give **two** device messages, one per key.
- A `get` of one TRV-ZBT day gives 7 device messages (the valve reports the whole week of the edit group). TRVZB days are not readable (no `get` access), and a `get` of one is ignored.
- Readable per model: TRVZB `system_mode`, `occupied_heating_setpoint`, `temperature_sensor_select` (and the other access-7 keys). TRV-ZBT: the same, plus `schedule_active_group` and `schedule_group_to_edit`. Days are not read on either model (see M4's decision).

## M3: how devices show they are alive

From the recording, 2026-11-15 12:04–15:29 UTC (3.4 h). The 24 h announce count and the restarts are still to come.

- **Valves:** every valve that gets the automation's 5-minute push sends a message at least every 5.2 min. Mancave, whose pushes stopped at 14:30 for M5, had a longest gap of 11.2 min so far.
- **Room sensors** (`sensor/th/*`, which report on change): the longest gaps were cabinet 47.4 min, bedroom 39.4, entrance 38.3, stairs 33.9, alisa-room 33.4, bathroom 32.3, kira-room 29.0, kitchen 28.0, living-room 24.1 and attic 22.6 min. **Stop rule hit:** a healthy sensor's longest gap is over 30 min, half of the 60 min staleness timeout.
- `last_seen` has a resolution of one second, so two device messages in the same second share it; this is normal. A message whose `last_seen` was **stale** (equal to the previous message's while more than 1.5 s had passed) appeared on a valve only right after our own `set` on the TRV-ZBT: Zigbee2MQTT's echo, before the valve answers (see M2). On valves and room sensors, `last_seen` changed every other time the device spoke. Several relays (outlets with power metering) repeat their state every few minutes with an unchanged `last_seen`.
- **Decision (user, 2026-11-15):** the sensor staleness timeout becomes 120 min. The 24 h recording must confirm that no healthy sensor is silent for 60 min or more.

## Radio commands (debug log, 15:36 UTC, about 45 s)

With the log level at `debug` (set through `bridge/request/options`, restored to `info` 45 s later; both answered `ok` with `restart_required: false`):

- **One radio command for a seven-day message (TRV-ZBT).** `{"schedule_group_to_edit":"3", weekly_schedule_<all 7 days>}` with the same week on every day produced a single `customSonoffTrvzbt.scheduleGroup` command, data `[1,1,2,12,127,…]`: day mask 127 = all seven days, 12 entries, group index 2 (= group 3). The valve answered 2 s later with its own frame `[25,85,19,1,1,2,0]` (command 19, group index 2, status 0). Zigbee2MQTT logged only two `set` calls (`schedule_group_to_edit` and one day), so it merges days with identical entries into one command. A week whose days differ was not measured; it is assumed to give one command per distinct day text.
- **An unchanged external temperature is written every time.** Two pushes of `19.6` 10 s apart each gave one `customSonoffTrvzbt.write({"externalTemperatureInput":1960})` radio write.
- This seven-day message also restored group 3's week to the restore card.

## M9: what a new subscriber receives

- At connect, a new subscriber to `zigbee2mqtt/#` receives retained messages only on `bridge/{info,state,devices,groups,definitions,extensions,converters,health}` and every device's `<name>/availability`. **No device state is retained**, and no device state arrives before the device speaks.
- **`retain` can be turned on per device** through `bridge/request/device/options` (`{"id":"<name>","options":{"retain":true}}`; answered `ok`, `restart_required: false`). With it on, a new subscriber got the valve's whole state at once, retained, carrying the `last_seen` of the valve's last message.
- **Turning `retain` off does not remove the retained message.** 15 s after `retain: false`, a new subscriber still got the old retained state, with its old `last_seen`. Publishing an empty retained payload to the device topic removed it. After that test the device option reads `{"retain": false}` instead of being absent, which behaves the same.

## Room sensors through Home Assistant

**Decision (user, 2026-11-15):** room sensors are read only through Home Assistant. Valves stay on MQTT.

- Home Assistant's temperature entity from Zigbee2MQTT updates `last_reported` **only when the value changes**. At 15:39 UTC, `sensor.sensor_th_bathroom_temperature` showed `last_reported` 10:42, five hours earlier, while over MQTT the same device had spoken at least every 32 minutes. Its humidity entity showed 14:59 and its battery entity 15:35.
- **Decision (user, 2026-11-15):** a sensor is alive when the newest `last_reported` among **all entities of its Home Assistant device** is recent. Its gaps then match the device's radio messages (M3: up to 47 min in 3.4 h).
- The room sensors here are SONOFF temperature and humidity sensors with a screen. Their devices have no `last_seen` entity enabled in Home Assistant.

### M5 result: fallback and recovery (TRVZB, mancave)

- The last push was at 14:30:00 UTC. `temperature_sensor_select` changed to **`remote_source_offline`** at 16:29:37 UTC: **fallback after 1 h 59 min 37 s**, so about 2 h, over the 90 min stop threshold. In fallback, `external_temperature_input` kept its last value (18.6) and `local_temperature` showed the valve's own reading (18.8).
- **The valve returns by itself.** One push (`18.8` on `…/set/external_temperature_input`, 16:30:09) produced device messages 3.7 s later, and within that same second the select read `remote_temperature` again. No select write was sent. One push is enough.
- The select's fallback value is `remote_source_offline`, which differs from `remote_temperature`. A binding that decodes only `remote_temperature` as `external` sees fallback as "not external" without any special rule.
- The label was put back on `sensor.sensor_th_cabinet_temperature` at 16:31 UTC.
- Feeding a valve that is `off` was not measured, so the value is "no".

## Skipped by the user (2026-11-15)

- M2/M7 batteries-out (window valve) and M6 1-minute battery swaps were skipped. Behaviour of writes and `get` to an unpowered valve, and rejoin after a short power loss, is not measured; implementers rely on the architecture's defaults (a write took only when the valve shows the desired value; rejoin seen via `bridge/event` announce).

## M3 Z2M restart (2026-11-15, UTC)

- `bridge/state` offline 18:53:26.2 → online 18:54:01.4 (35 s down). No `bridge/event` for the test valves.
- `<name>/availability` online for both valves 2.5–3.9 s after bridge online (all devices republished in a ~1 s burst).
- One replayed state per valve 4.5 s after bridge online: **old `last_seen`** (mancave 18:50:00, window 18:50:01 — the last real report before the restart), fresh `linkquality` only. A replay is not a valve report; only a newer `last_seen` counts.
- Replay carries the cached state from before the restart unchanged: window `schedule_active_group` 1, `schedule_group_to_edit` 3 (edit group survives the restart in the cache), mancave still heat/17 with the modified Sunday.

## M3 HA restart (2026-11-15, UTC)

- HA came back ~18:56:44. Z2M reacted to HA's birth (`homeassistant/status online`, not in the recording, which covers `zigbee2mqtt/#` only) by republishing `bridge/state` online and every device's cached state in one burst (~206 messages within 6 s).
- The republished valve states carry **old `last_seen`** (mancave 18:55:14, window 18:55:01 — the last real reports). Same rule as the Z2M restart: a replay is not a valve report.
- HA wrote nothing to the valves on startup; the next writes were the regular 5-min `external_temperature_input` pushes at 19:00:00.
- `bridge/state online` can arrive without any preceding offline (HA restart, not Z2M); it must not be treated as a Z2M restart.

## Step 3 restore (2026-11-15, 19:00:32–19:01:27 UTC)

Both valves restored from the restore cards and checked against the next valve reports (fresh `last_seen` 19:01:14 and 19:01:39 UTC): every key on the cards matches. Window valve: active group 1, edit group 1, group 1 week back to the card. Recheck due ~19:31 UTC.

## Room overrides (plan 3a, Task 1, 2026-11-19 to 2026-11-22, UTC)

Script-driven writes through a recorder on `zigbee2mqtt/#`; at-valve steps by the user. Restore cards were taken again at 18:27:26 on 2026-11-19 (both at `heat` 17; frost 7 / 5). Chauffage (an HA integration that writes `…/set/occupied_heating_setpoint`) was paused on mancave for the tests.

### M10: TRVZB timer mode

- One message `{"temporary_mode_select":"timer","timer_mode_target_temp":20,"temporary_mode_duration":2}` from `auto`: `system_mode` stays `auto` and the setpoint shows 20.
- The timer ends by itself after 2 min (+122 s) and the valve returns to the schedule's value, still in `auto`.
- Zigbee2MQTT keeps `timer/20/2` cached afterwards.
- The TRVZB has no boost button and no way to set a timer at the valve. Boost and timer are remote only.

### M11: knob in `auto`

- **TRVZB.** The first click only switches the valve to `heat` and shows its **last manual heat setpoint**. Reports: `heat <auto value>`, then `heat <last manual>`. Later clicks change the setpoint, and the valve stays in `heat`.
- **TRV-ZBT.** The first click only wakes the screen. Later clicks change the setpoint, and the valve **stays in `auto`**, holding the value (hand icon) as in M15.
- **TRV-ZBT top button.** The first press switches to `heat` with the last manual heat setpoint; a brief `auto <that value>` shows first. A second press returns to `auto` at the schedule's value; a brief `heat <schedule value>` shows first.
- **Report timing, both models.** Fast clicks give reports about 2–3 s apart, with the values in between. Clicks 3 s apart give one report each. The value is reported only after the screen's confirmation flash.
- One continuous TRVZB turn (2026-11-20 00:41) showed `heat`→`auto`→`heat` within 17 s before settling at `heat` 22.5. It is not explained.

### M12: `system_mode` writes and the valves' own controls

- **`auto`** takes the schedule's value in force within 2.0 s on both models (TRVZB 22, TRV-ZBT 19).
- **`heat`** alone returns to the last manual heat setpoint (17), not to the value shown in `auto`.
- **`off`** reports setpoint = frost protection (TRVZB 7, TRV-ZBT 5).
- Every mode write showed in full within 2.0 s.
- **Knob in `off` (TRVZB).** The screen shows OF and the valve sends no report.
- **Knob below 4 (TRVZB).** Turning in `heat` below the minimum switches to `off` (screen OF). Near the bottom, reports flipped between `off` and `heat`, and between 4 and 7, for 12 s before settling at `heat` 4. The knob reaches 4, below frost protection 7.
- **Child lock (TRVZB).** With `LOCK`, every turn or press shows LC; no report and no change.
- **TRVZB day write in `heat` and in `off`:** the mode is unchanged.
- **Not measured:** the TRVZB's own min/max clamping of a written setpoint, and either model's own window detection (not triggered).

### M13: `frost_protection_temperature`

- On both models, 8 is written, echoed within 2 s, and returned by a `get`. Restored to 7 / 5.
- `get` with `""` for `system_mode`, `occupied_heating_setpoint` and `frost_protection_temperature` answers in 0.85–1.8 s: 3 messages each, with a fresh `last_seen`.

### M14: echoes

- **Echo pattern.** The first message after a write has a fresh `last_seen` but the old state. Zigbee2MQTT's echo with the new value follows, carrying the **same** `last_seen`.
- **`last_seen` resolution.** It is truncated to the second. Once (2026-11-19 19:12:33), the confirming `last_seen` was 0.45 s **before** the write instant.
- **Half-applied states** last under 1 s. In a combined write from `off`, the TRVZB shows the mode first (`heat 7`, +0.4 s) and the TRV-ZBT the setpoint first (`off 17`, ~0.7 s).
- **TRV-ZBT `{auto, 21}` from `heat` 17:** a transient `heat 19` (old mode, the schedule's value) shows before `auto 21`.
- **TRVZB combined `{heat, 20}` from `auto` 22:**
  - `heat 22` at +0.3 s;
  - `heat 17` at +0.8 s (the last manual heat setpoint);
  - `heat 20` only at +14.6 s, in an echo carrying the +0.8 s `last_seen`.

  In batch 2 the same write took 10.1 s.
- **Slowest write-to-full-show:** 14.6 s. Every write showed in full within 60 s, and no key was lost.

### M15: TRV-ZBT holds

- `auto` + 21 in one message: `auto 21`, held.
- `auto` written again: the held value is dropped and the schedule's value (19) returns.
- A setpoint alone in `auto`: held, and the valve stays in `auto`.
- A day write with the same points: the held value is **not** dropped.

### M16: rejoin

- **TRVZB** (batteries ran flat, 2026-11-20 00:43; new batteries fitted):
  - four `device_announce` within 70 s; the valve came back in `auto` 18 each time;
  - at 00:44:15 it switched to `heat` 18 with no write, while the user was handling the valve, so the cause is unclear;
  - Heatmaster's rejoin handling re-sent the week and `temperature_sensor_select`; the week write failed with a ZCL error;
  - the valve kept its week (`auto` 22 at the 07:00 point).
- **TRV-ZBT** (batteries out, 2026-11-20 ~17:25):
  - silent for ~5.7 min, then `Configuring` and a `device_announce` at 17:30:47;
  - a queued `set` and `get` landed on return;
  - reports: `auto 19` (cache), `auto 17`, `heat 17`, `heat 19`, then `auto 19` at 17:31:03 — buttons may have been pressed while refitting, so this is inconclusive;
  - `temperature_sensor_select` fell to `local_temperature` at 17:31:05; the user's automation set `remote_temperature` again at 17:35:00;
  - the written week ran afterwards (16 at 22:00 local, 19 at 06:00).
- A clean, hands-off repeat on both models is postponed by the user.

### Writes from outside the tests

- **Mancave (2026-11-19):** `…/set/occupied_heating_setpoint 17` at 18:44:05 and 18:54:09, 0.75 s after the valve left `off`, switching it from `auto` to `heat` 17. The writer is the chauffage integration.
- **Window valve (2026-11-22):** the same per-key write at 05:56:22 and 09:57:00.

## Window handling (plan 3b, Task 1, 2026-11-27, UTC)

Restore cards before the tests:
- mancave (TRVZB): `open_window` OFF, `auto` 22, frost 7;
- window valve (TRV-ZBT): `open_window` ON, `open_window_detected` false, `heat` 17, frost 5.

### M17: `open_window` writes

On both models, through Zigbee2MQTT `/set`, `ON` and `OFF` in turn:
- **Evidence: acked.** The valve's first message after the write repeats the old value with a fresh `last_seen`; a second message in the same millisecond shows the new value. Then one more report follows about 1 s later.
- **Timing:** the new value shows 0.9–2.1 s after the write.
- **Read-back:** a `get` of `open_window` returns the written value 1–2 s later, with a fresh `last_seen`.
- **Spelling:** `"ON"` / `"OFF"` on both models. The TRV-ZBT also reports `open_window_detected` (boolean); the TRVZB does not.
- **Side effects:** the write changed no other key (mode, setpoint and frost protection unchanged).
- Both valves were restored to their cards (mancave OFF at 20:30:15, window valve ON at 20:30:47) and confirmed by a `get`.
