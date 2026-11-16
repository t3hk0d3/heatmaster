# Heatmaster

Heatmaster runs room schedules and weighted room temperatures on Sonoff radiator valves through
Zigbee2MQTT. The full documentation is in the repository README:

- [What it is and what it needs](https://github.com/t3hk0d3/heatmaster#what-heatmaster-is)
- [Install as an app](https://github.com/t3hk0d3/heatmaster#install-as-an-app)
- [First run](https://github.com/t3hk0d3/heatmaster#first-run)
- [What Heatmaster does to a valve](https://github.com/t3hk0d3/heatmaster#what-heatmaster-does-to-a-valve)
- [Rollback](https://github.com/t3hk0d3/heatmaster#rollback)
- [What uninstall deletes and keeps](https://github.com/t3hk0d3/heatmaster#what-uninstall-deletes-and-keeps)
- [When a file cannot be read](https://github.com/t3hk0d3/heatmaster#when-a-file-cannot-be-read)
- [One instance only](https://github.com/t3hk0d3/heatmaster#one-instance-only)

**Who can open the page.** Only administrators: the Supervisor refuses the ingress of an app with
`panel_admin` to every other user.

**When the app halts.** If the server fails five times within 15 minutes the container stops (exit
code 1). With the app's Watchdog switch on it is started again and halts again at once until 15
minutes have passed since the first of the five starts. The valves then lose the temperature feed
and fall back to their own sensor. The app's log (Settings, Apps, Heatmaster, Log) says why.
