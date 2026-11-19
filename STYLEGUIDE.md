# Heatmaster styleguide

Every task and every plan follows this file. If a rule here is wrong, change the rule in its own
commit first; do not mix conventions.

## Layout

- A pnpm workspace: `packages/core`, `packages/server`, `packages/web`, and `packaging/` (the
  container and Home Assistant app files).
- Files are kebab-case, one module per file.
- Tests sit beside the code as `<name>.test.ts`. Tests that belong to no single module live under
  the package's `test/` folder: the simulator (`packages/core/test/sim/`), the test builders
  (`packages/core/test/builders.ts`), fixtures, and the platform and import-boundary tests.
- `packages/core/src/index.ts` is the public surface of core. Every task that adds a core module
  exports its public names from it.

## Import boundaries

- Nothing in `core` imports from outside `core`: no Node module, no npm package, no other workspace
  package. Its relative imports stay inside `packages/core/src`.
- `server` may import `core`. `web` may import only types from `core` (`import type`).
- Another package is imported by its name (`@heatmaster/core`), never by a relative path, and only
  through its `index.ts`.
- Test files and everything under a `test/` folder may also import `vitest`, `@fast-check/vitest`,
  `fast-check`, `eslint`, `vite`, Node modules, the package's own `src/` and `test/` files, and the
  root `vitest.setup.ts`.
- ESLint enforces all of this (`eslint.boundaries.js`). The core also may not use `Date.now()`,
  `Temporal.Now`, `setTimeout`, `setInterval`, `Math.random()`, `process` or `console`.

## Language

- Node 26, TypeScript in strict mode, ES modules.
- Node runs the source files as they are, so: relative imports carry the `.ts` extension; types are
  imported with `import type`; only syntax that can be erased is used (no `enum`, no `namespace`,
  no constructor parameter properties).
- `Temporal` is the built-in one; there is no polyfill.

## Naming

- Functions and fields are `camelCase`, types are `PascalCase`, constants are `UPPER_SNAKE`.
- Storage ids are lowercase slugs.
- Codes (validation issues, refusals, problem kinds, states) are lower-case `snake_case` strings.
- Effect kinds are the one exception: they are camelCase verbs, as in the architecture
  (`saveLedger`, `writeOriginalsCopy`, `saveConfig`, `publish`, `publishSetpoint`,
  `pushTemperature`, `refresh`), and so are the kinds of `LabelOp`, the label operations planned
  for Home Assistant (`createLabel`, `renameLabel`, `deleteLabel`, `labelArea`, `labelEntity`).
  Event kinds are `snake_case`.
- JSON key casing: the stored files, the config document and the MQTT discovery payloads use
  `snake_case` keys; the HTTP API's own shapes (`wire.ts`) and error `data` use `camelCase`.
- An instant is a field named `at` or `<something>At` (`heardAt`, `messageAt`, `at`), never with a
  unit suffix: `sent.at`, not `sent.atMs`. A duration is the opposite: see Time.

## Data

- Plain readonly objects and arrays: `type X = Readonly<{ … }>`. The variants of a discriminated
  union are wrapped in `Readonly<…>` too.
- A mapping keyed by an id (a valve, a device, a room, a sensor) is a `ReadonlyMap`.
- A mapping keyed by a fixed set of names (setting keys, groups, weekdays, transport and link keys)
  is a `Readonly<Record<…>>`, partial where a key may be missing.
- A value that crosses the API holds only JSON types, so there every mapping is a
  `Readonly<Record<…>>`.
- No classes in `core`, except its three error classes: `ConfigError`, `ChangeRefused`,
  `LedgerError`.
- A fixed set of names is a union of string literals, lower-case `snake_case` except effect and
  `LabelOp` kinds:
  `type Membership = "managed" | "not_adopted" | "releasing" | "stray" | "orphan" | "frozen"`.
- A union of shapes (effects, events) is told apart by a `kind` field:
  `{ kind: "publish", valveId, values }`.

## Unknown values

- In a mapping, a missing key means unknown. `null` means "present but could not be read".
- A field that may be absent is always written and typed `| undefined`, never `?:`. Exceptions:
  raw JSON documents, because JSON has no `undefined`; the shapes of `wire.ts`, which are exchanged
  JSON documents too; and the option objects of test helpers and builders, which may use `?:`.

## Time

- The core never reads the clock; time and state are arguments.
- `now` is a `Temporal.ZonedDateTime` in the house's zone. Where a number is passed, the current
  time is called `nowMs`.
- Stored instants are epoch milliseconds (`number`).
- Durations and intervals are milliseconds (`number`). A constant that holds a duration ends in
  `_MS` and is written as arithmetic (`VALVE_SILENT_AFTER_MS = 2 * 60 * 60 * 1000`). A field or
  parameter that holds a duration ends in `Ms` (`maxAgeMs`, `staleAfterMs`). A field that holds an
  instant has no such ending.
- A schedule time of day is an `"HH:MM"` text in raw documents and a `Temporal.PlainTime` in the
  model.

## Signatures

Signatures are written in TypeScript, for example
`aggregate(sensors: readonly SensorRef[], readings: ReadonlyMap<string, SensorReading>, nowMs: number, staleAfterMs: number): RoomTemperature`.

## No write memory

No module stores or passes command ids, write results or in-flight records. What a valve shows is
compared with what is wanted, every tick.

One exception: the room thermostat's valve expectations (plan 3a, `ValveExpectation.sent`) keep the
mode and setpoint writes Heatmaster sent, with their instants and what the valve showed then, only
to tell Heatmaster's own doing from a person's change on the valve. No other module stores write
records.

## Decisions live in the core

The server collects inputs, calls a core function and executes the effects it returns, in order. It
never decides whether to write.

## Rounding

Temperatures round half up (19.25 → 19.3 at 0.1; 19.75 → 20.0 at 0.5). A value within
0.000000001 below a half counts as the half, so binary fractions do not turn 19.25 into 19.2.

## Errors

- The core throws `ConfigError` (with `issues`) from validation, `ChangeRefused` (with `code` and
  `data`) from config changes, and `LedgerError` from `ledgerFromRaw`.
- A caller's mistake (a second record for one valve in `withRecord`, a day `encodeDay` cannot
  encode) throws a plain `Error` or `RangeError`. `tick` never throws on bad observations; it
  reports a problem.
- Bindings never throw on a payload they cannot decode; the value is unknown.
- The server maps errors to HTTP responses that carry a `code`.
- Tests assert on codes, paths and data, never on message text.
  Exceptions: checks on process output, and checks that a secret is absent from output, are
  about printed text by nature and are allowed.

## Tests

- vitest. `describe(module) → describe(function) → describe(scenario) → it(effect)` mirrors the
  plan's BDD skeleton one to one, with the skeleton's wording. One test per effect.
- Core tests use nothing from `server`.
- Time is always passed in; no test sleeps. A test waits for an event (a log line, an exit), never
  for a time.
- Property tests use fast-check through `@fast-check/vitest`, with a fixed seed in CI
  (`FC_PROFILE=ci`: 50 runs; otherwise 200 runs, no seed).
- Values that hold Temporal objects are compared with `toEqual`, which `vitest.setup.ts` teaches to
  compare them by value.

## Logging

The server logs through Fastify's logger, one JSON line per event, and nothing at `info` on the
tick path. The core never logs.

## Texts

Every text the web page shows has a key in both of its language files (`en`, `ru`). The API returns
codes and data, not sentences.

## Dependencies

- Exact versions in every `package.json` (`.npmrc` sets `save-exact`); the lockfile is committed.
- `core` has no dependencies.
- Shared tooling (TypeScript, ESLint, Prettier, vitest, fast-check, Vite) is installed once at the
  root. A test library that only one package uses is a devDependency of that package, at an exact
  version.

## Tooling

- ESLint with typescript-eslint's strict type-checked rules and the boundary rules above;
  Prettier with a line width of 100; `tsc --noEmit`.
- `pnpm check` runs lint, types and all tests (with `FC_PROFILE=ci`). `pnpm build` builds the web
  page. `pnpm format` writes Prettier's formatting.

## Commits

Conventional Commits, one task per commit unless a task says otherwise. No session links.

## Commands

Run every command as `set -o pipefail; <command> 2>&1 | tee "$LOGDIR/<name>.log"` and re-read the
log instead of rerunning (see the plan header).
