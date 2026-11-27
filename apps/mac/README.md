# Tallo Sweep (macOS menu bar app)

A menu-bar app that runs the sweep (`tallo sweep start`), shows how it is going, and pauses it by itself when the Mac
sleeps, goes offline, runs hot or (optionally) runs low on battery. macOS 27 or later; the interface uses Liquid Glass.

It is a thin controller. It starts the runner as a child process, reads the files the sweep already writes
(`~/Library/Logs/tallo/sweep/status.json`, `events.jsonl`) and orders it through `control.json`, the same file
`tallo sweep pause` writes. A sweep that is already running (started from a terminal, or by the app before it
restarted) is adopted rather than started twice.

## Build and run

```sh
cd apps/mac
xcodegen generate                      # project.yml -> TalloSweep.xcodeproj (not committed)
helpers xcode build . --opts '{"scheme":"TalloSweep"}'
swift test                             # the logic package: status format, control file, pause rules
xcodebuild test -project TalloSweep.xcodeproj -scheme TalloSweep -destination 'platform=macOS'
```

Install a Release build with `xcodebuild -project TalloSweep.xcodeproj -scheme TalloSweep -configuration Release
-derivedDataPath build build`, then copy `build/Build/Products/Release/TalloSweep.app` to `/Applications`. The first
launch adds it to Login Items (Settings > General turns that off).

`--sweep-dir <folder>` points the app at another set of sweep files, and `--show-dashboard` opens the window at
launch: both are for trying it without a real sweep.

## Layout

- `Sources/TalloSweepKit` (package, no UI): `SweepStatus` (reads `status.json` leniently), `ControlFile` (writes
  `control.json` the way the CLI does), `PauseCoordinator` (the pause rules as a pure state machine), `SweepCommand`
  (the exact command that starts the runner), `SweepHealth`, `EventLog`, `SweepSettings`.
- `App` (SwiftUI): `SweepModel` ties the pieces together; `SystemSignals` turns sleep, wake, network, battery and
  heat into events; `SweepProcess`, `KeepAwake`, `Notifier` and `LoginItem` wrap the system; the views are the menu bar
  label, the popover, the settings and an optional window.
- `AppTests`: the model against a temporary folder standing in for a sweep.

## What pauses the sweep

| Reason | Resumes |
| --- | --- |
| You press Pause | when you press Resume |
| The Mac sleeps (lid, Apple menu, idle) | on wake, after a short settle, once the network is back |
| No network | when the network returns |
| Battery below your floor (optional) | on power, or 5 points above the floor |
| The Mac runs hot | when it cools |
| The sweep holds itself at its row budget | never by itself: raise the budget from the terminal |

Pausing stops new boards from starting; boards already running finish. Display sleep and screen lock do not pause.
The app holds a power assertion while seeding so the Mac does not idle-sleep (the sweep is started with
`--no-caffeinate` so that pausing lets the Mac sleep); closing the lid on battery still sleeps.
