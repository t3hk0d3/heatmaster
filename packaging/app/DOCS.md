# Heatmaster

Heatmaster runs room schedules and weighted room temperatures on Sonoff radiator valves through
Zigbee2MQTT; since 0.3.0 each room is one thermostat. The full documentation is in the README:

- [What it is and what it needs](https://github.com/t3hk0d3/heatmaster#what-heatmaster-is)
- [Rooms come from Home Assistant](https://github.com/t3hk0d3/heatmaster#rooms-come-from-home-assistant)
- [The room thermostat](https://github.com/t3hk0d3/heatmaster#the-room-thermostat): room states, end
  rules, the climate entity and its two selects, changes made on a valve, frost protection,
  `state.json` and Start over
- [Install as an app](https://github.com/t3hk0d3/heatmaster#install-as-an-app)
- [First run](https://github.com/t3hk0d3/heatmaster#first-run)
- [Labels](https://github.com/t3hk0d3/heatmaster#labels)
- [Upgrading from 0.1](https://github.com/t3hk0d3/heatmaster#upgrading-from-01)
- [Upgrading to 0.3.0](https://github.com/t3hk0d3/heatmaster#upgrading-to-030)
- [Pending valves](https://github.com/t3hk0d3/heatmaster#pending-valves)
- [What Heatmaster does to a valve](https://github.com/t3hk0d3/heatmaster#what-heatmaster-does-to-a-valve)
- [Rollback](https://github.com/t3hk0d3/heatmaster#rollback)
- [What uninstall deletes and keeps](https://github.com/t3hk0d3/heatmaster#what-uninstall-deletes-and-keeps)
- [When a file cannot be read](https://github.com/t3hk0d3/heatmaster#when-a-file-cannot-be-read)
- [One instance only](https://github.com/t3hk0d3/heatmaster#one-instance-only)

**Valve modes.** From 0.3.0 Heatmaster sets the mode of every valve it manages. An override is held in
`heat`, so a valve left in an override stays at its temperature while the app is stopped, until the app
runs again. Releasing a valve puts back its mode, its frost protection and, only if its original
mode was `heat`, its setpoint. Valves joined before 0.3.0 keep theirs.

**Who can open the page.** Only administrators: the Supervisor refuses the ingress of an app with
`panel_admin` to every other user.

**When the app halts.** If the server fails five times within 15 minutes the container stops (exit
code 1). With the app's Watchdog switch on it is started again and halts again at once until 15
minutes have passed since the first of the five starts. The valves then lose the temperature feed
and fall back to their own sensor. The app's log (Settings, Apps, Heatmaster, Log) says why.
