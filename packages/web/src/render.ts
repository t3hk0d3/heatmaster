import type {
  ApiError,
  PendingView,
  PlanView,
  ProblemView,
  RoomView,
  StateView,
  UnassignedValveView,
  ValveView,
  WriteView,
} from "@heatmaster/core";
import { canApply } from "./editor.ts";
import type { EditorState } from "./editor.ts";
import type { ConnectionStatus } from "./events.ts";
import { DICTIONARIES, codeText, isTextKey } from "./i18n.ts";
import type { Language, Translate } from "./i18n.ts";

/** TRV-ZBT day readback is cache, not the valve's schedule: it is never shown. */
const WRITE_ONLY_DAYS_MODEL = "TRV-ZBT";

type Child = Node | string;

function el(
  tag: string,
  attributes: Readonly<Record<string, string>>,
  ...children: readonly Child[]
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  for (const child of children) {
    // Text reaches the page through textContent only, never as markup.
    if (typeof child === "string") {
      const text = document.createElement("span");
      text.textContent = child;
      element.append(text);
    } else {
      element.append(child);
    }
  }
  return element;
}

function textElement(
  tag: string,
  text: string,
  attributes: Record<string, string> = {},
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.textContent = text;
  return element;
}

function button(
  label: string,
  action: string,
  extra: Readonly<Record<string, string>> = {},
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.dataset.action = action;
  for (const [name, value] of Object.entries(extra)) element.setAttribute(name, value);
  return element;
}

function labelled(label: string, value: Child): HTMLElement {
  return el("div", { class: "field" }, textElement("dt", label), el("dd", {}, value));
}

export function formatTemperature(value: number | undefined, language: Language): string {
  if (value === undefined) return DICTIONARIES[language].unknown;
  const number = new Intl.NumberFormat(language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
  return `${number} °C`;
}

export function valveActions(valve: ValveView): readonly ("refresh" | "restore" | "forget")[] {
  const actions: ("refresh" | "restore" | "forget")[] = [];
  if (valve.supported) actions.push("refresh");
  if (valve.membership === "orphan") actions.push("restore");
  if (
    valve.membership === "orphan" ||
    valve.membership === "releasing" ||
    valve.stranded === true
  ) {
    actions.push("forget");
  }
  return actions;
}

function valveButtons(valve: ValveView, t: Translate): HTMLElement {
  const holder = el("div", { class: "actions" });
  for (const action of valveActions(valve)) {
    holder.append(button(t(`valve.${action}`), action, { "data-valve-id": valve.valveId }));
  }
  return holder;
}

function codeOrUnknown(t: Translate, prefix: string, code: string | undefined): string {
  return code === undefined ? t("unknown") : codeText(t, prefix, code);
}

/** A reported value in words: a day is its set points, an unknown value is the "unknown" text. */
function formatValue(value: unknown, t: Translate): string {
  if (value === null || value === undefined) return t("unknown");
  if (Array.isArray(value)) return value.map((item) => formatValue(item, t)).join(", ");
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isDaySetting(setting: string): boolean {
  return setting.startsWith("day_");
}

function hidesDays(modelId: string | undefined): boolean {
  return modelId === WRITE_ONLY_DAYS_MODEL;
}

export function renderHeader(
  state: StateView | undefined,
  status: ConnectionStatus,
  language: Language,
  t: Translate,
): HTMLElement {
  const header = el("header", { class: "top" });
  header.append(textElement("h1", t("app.title")));
  header.append(textElement("p", t(`header.status.${status}`), { class: "connection" }));

  if (state !== undefined) {
    const links = el("ul", { class: "links", "aria-label": t("header.links") });
    for (const [key, up] of Object.entries(state.links)) {
      const fault = state.transportFaults[key];
      const parts = [`${codeText(t, "link", key)}: ${up ? t("header.up") : t("header.down")}`];
      if (fault !== undefined) parts.push(codeText(t, "reason", fault));
      links.append(textElement("li", parts.join(" — ")));
    }
    header.append(links);

    header.append(
      textElement("p", state.held ? t("header.held") : t("header.not_held"), { class: "held" }),
    );
    header.append(
      state.held ? button(t("header.release"), "release") : button(t("header.stop"), "hold"),
    );
    header.append(
      textElement("p", t("header.revision", { revision: state.revision }), { class: "revision" }),
    );
  }

  const languages = el("div", {
    class: "languages",
    role: "group",
    "aria-label": t("header.language"),
  });
  for (const code of ["en", "ru"] as const) {
    const choice = button(t(`header.language_${code}`), "language", { "data-language": code });
    if (code === language) choice.setAttribute("aria-pressed", "true");
    else choice.setAttribute("aria-pressed", "false");
    languages.append(choice);
  }
  header.append(languages);

  const diagnostics = textElement("a", t("header.diagnostics"), { href: "api/diagnostics" });
  header.append(diagnostics);
  return header;
}

function renderValveRow(valve: ValveView, t: Translate): HTMLElement {
  const row = el("li", { class: "valve" });
  row.append(textElement("strong", valve.name));
  row.append(textElement("code", valve.valveId, { class: "valve-id" }));
  const facts = el("dl", {});
  facts.append(
    labelled(t("valve.membership"), codeOrUnknown(t, "membership", valve.membership)),
    labelled(t("valve.liveness"), codeOrUnknown(t, "liveness", valve.liveness)),
    labelled(t("valve.sync"), codeOrUnknown(t, "sync", valve.sync)),
  );
  row.append(facts);
  if (valve.battery !== undefined) {
    row.append(textElement("span", t("valve.battery", { percent: valve.battery })));
  }
  if (!valve.supported) row.append(textElement("span", t("valve.not_supported")));
  if (valve.stranded === true) row.append(textElement("p", t("valve.stranded")));
  row.append(valveButtons(valve, t));
  return row;
}

function roomName(state: StateView, roomId: string): string {
  return state.rooms.find((room) => room.roomId === roomId)?.name ?? roomId;
}

/** The banner while rooms are frozen on the saved areas, or without a Home Assistant link. */
export function renderHouse(state: StateView, t: Translate): HTMLElement {
  const box = el("div", { class: "house" });
  if (state.house === "frozen") {
    const key =
      state.frozenReason === "link_down" ? "house.frozen.link_down" : "house.frozen.not_loaded";
    box.append(textElement("p", t(key), { class: "banner", role: "status" }));
  } else if (state.house === "unlinked") {
    box.append(textElement("p", t("house.unlinked"), { class: "banner", role: "status" }));
  }
  return box;
}

/** What a user does about a saved configuration that cannot be read; nothing otherwise. */
export function renderConfigUnreadable(state: StateView, t: Translate): HTMLElement {
  const box = el("div", { class: "config-unreadable" });
  if (state.configState !== "unreadable") return box;
  const notice = el("section", { class: "banner error", role: "alert" });
  notice.append(
    textElement("h2", t("config_unreadable.title")),
    textElement("p", t("config_unreadable.why")),
    textElement("p", t("config_unreadable.recover")),
  );
  box.append(notice);
  return box;
}

function renderRoom(
  room: RoomView,
  state: StateView,
  language: Language,
  t: Translate,
): HTMLElement {
  const article = el("article", { class: "room" });
  article.append(textElement("h3", room.name));
  if (!room.managed) {
    article.append(
      textElement("p", t("room.not_managed"), { class: "mark not-managed" }),
      textElement("p", t("room.not_managed_hint")),
    );
  }
  const scheduleName = room.scheduleName ?? room.scheduleId;
  article.append(
    textElement(
      "p",
      scheduleName === undefined
        ? t("room.no_schedule")
        : t("room.schedule", { name: scheduleName }),
      { class: "schedule" },
    ),
  );
  const facts = el("dl", {});
  facts.append(
    labelled(t("rooms.temperature"), formatTemperature(room.currentTemperature, language)),
    labelled(t("rooms.target"), formatTemperature(room.target, language)),
    labelled(t("rooms.sync"), codeText(t, "sync", room.sync)),
  );
  article.append(facts);
  if (room.degraded) article.append(textElement("p", t("rooms.degraded"), { class: "mark" }));
  if (room.diverged) article.append(textElement("p", t("rooms.diverged"), { class: "mark" }));

  article.append(textElement("h4", t("rooms.valves")));
  const byId = new Map(state.valves.map((valve) => [valve.valveId, valve]));
  if (room.valveIds.length === 0) {
    article.append(textElement("p", t("rooms.no_valves")));
  } else {
    const list = el("ul", { class: "valves" });
    for (const valveId of room.valveIds) {
      const valve = byId.get(valveId) ?? { valveId, name: valveId, supported: false };
      list.append(renderValveRow(valve, t));
    }
    article.append(list);
  }
  return article;
}

export function renderRooms(state: StateView, language: Language, t: Translate): HTMLElement {
  const section = el("section", { class: "rooms" });
  section.append(textElement("h2", t("rooms.title")));
  if (state.rooms.length === 0) section.append(textElement("p", t("rooms.none")));
  for (const room of state.rooms) section.append(renderRoom(room, state, language, t));
  return section;
}

function renderReported(entry: UnassignedValveView, valve: ValveView, t: Translate): HTMLElement {
  const holder = el("div", { class: "reported" });
  if (!entry.observed) {
    holder.append(textElement("p", t("others.not_reported")));
    return holder;
  }
  holder.append(
    textElement("p", `${t("valve.liveness")}: ${codeText(t, "liveness", entry.liveness)}`),
  );
  const shown = Object.entries(entry.values).filter(
    ([setting]) => !(hidesDays(valve.modelId) && isDaySetting(setting)),
  );
  holder.append(textElement("h5", t("others.reported")));
  const list = el("dl", {});
  for (const [setting, value] of shown) {
    list.append(labelled(codeText(t, "setting", setting), formatValue(value, t)));
  }
  holder.append(list);
  return holder;
}

export function renderPending(state: StateView, t: Translate): HTMLElement {
  const section = el("section", { class: "pending" });
  if (state.pending.length === 0) return section;
  section.append(textElement("h2", t("pending.title")), textElement("p", t("pending.hint")));
  const list = el("ul", {});
  for (const pending of state.pending) {
    const item = el(
      "li",
      { class: "pending-valve" },
      textElement(
        "strong",
        t("pending.item", { name: pending.name, room: roomName(state, pending.roomId) }),
      ),
      textElement("p", codeText(t, "pending.reason", pending.reason)),
    );
    if (pending.unreadable.length > 0) {
      const settings = pending.unreadable.map((setting) => codeText(t, "setting", setting));
      item.append(textElement("p", t("pending.unreadable", { settings: settings.join(", ") })));
    }
    if (pending.reason === "originals_unreadable") {
      item.append(
        button(t("pending.accept"), "accept-originals", { "data-valve-id": pending.valveId }),
      );
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

export function renderUnused(state: StateView, t: Translate): HTMLElement {
  const section = el("section", { class: "unused" });
  if (state.unusedEntries.length === 0) return section;
  section.append(textElement("h2", t("unused.title")), textElement("p", t("unused.hint")));
  const list = el("ul", {});
  for (const areaId of state.unusedEntries) list.append(textElement("li", areaId));
  section.append(list);
  return section;
}

/** Newest first: the server sends them oldest first. */
export function renderHaChanges(state: StateView, language: Language, t: Translate): HTMLElement {
  const section = el("section", { class: "ha-changes" });
  if (state.haChanges.length === 0) return section;
  section.append(textElement("h2", t("ha_changes.title")), textElement("p", t("ha_changes.hint")));
  const formatter = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  const list = el("ul", {});
  for (const change of [...state.haChanges].reverse()) {
    const time = formatter.format(new Date(change.at));
    const item = el(
      "li",
      { class: "ha-change" },
      textElement("strong", t("ha_changes.revision", { revision: change.revision, time })),
    );
    const lines = el("ul", {});
    for (const entry of change.items) {
      const area = entry.areaId === undefined ? "" : roomName(state, entry.areaId);
      lines.append(
        textElement(
          "li",
          t(`ha_changes.item.${entry.kind}`, {
            area,
            entity: entry.entityId ?? "",
            schedule: entry.scheduleId ?? "",
          }),
        ),
      );
    }
    item.append(lines);
    list.append(item);
  }
  section.append(list);
  return section;
}

export function renderUpgrade(state: StateView, t: Translate): HTMLElement {
  const section = el("section", { class: "upgrade" });
  const report = state.upgrade;
  if (report === undefined) return section;
  section.append(
    textElement("h2", t("upgrade.title")),
    textElement("p", t("upgrade.intro", { version: report.fromVersion })),
  );
  if (report.droppedRooms.length === 0) {
    section.append(textElement("p", t("upgrade.none_dropped")));
  } else {
    const list = el("ul", {});
    for (const room of report.droppedRooms) {
      list.append(
        textElement(
          "li",
          t("upgrade.room", {
            name: room.name,
            roomId: room.roomId,
            valves: room.valveIds.length === 0 ? t("upgrade.no_valves") : room.valveIds.join(", "),
            reason: codeText(t, "upgrade.dropped", room.reason),
          }),
        ),
      );
    }
    section.append(list);
  }
  section.append(button(t("upgrade.dismiss"), "dismiss-upgrade"));
  return section;
}

export function renderOtherValves(state: StateView, t: Translate): HTMLElement {
  const section = el("section", { class: "others" });
  section.append(textElement("h2", t("others.title")));
  const others = state.valves.filter((valve) => valve.roomId === undefined);
  if (others.length === 0) {
    section.append(textElement("p", t("others.none")));
    return section;
  }
  section.append(textElement("p", t("others.hint")));
  const entries = new Map(state.unassigned.map((entry) => [entry.valveId, entry]));
  const list = el("ul", { class: "valves" });
  for (const valve of others) {
    const row = renderValveRow(valve, t);
    const entry = entries.get(valve.valveId);
    if (entry?.reason !== undefined) {
      row.append(
        textElement("p", codeText(t, "unassigned.reason", entry.reason), { class: "reason" }),
      );
    }
    if (entry !== undefined) row.append(renderReported(entry, valve, t));
    list.append(row);
  }
  section.append(list);
  return section;
}

/** What a code in a problem's data stands for: its text where it has one. */
const PROBLEM_CODE_PARAMS: Readonly<Record<string, string>> = {
  setting: "group",
  reason: "reason",
  transport: "link",
  mode: "mode",
  store: "store",
  op: "label_op",
};

/** The `reason` of these problems has its own texts; any other reason is a link's. */
const PROBLEM_REASON_PREFIX: Readonly<Record<string, string>> = {
  sensor_label_unused: "problem.sensor_label_unused",
  valve_pending: "pending.reason",
  rooms_frozen: "frozen_reason",
};

function problemText(problem: ProblemView, state: StateView, t: Translate): string {
  const key = `problem.${problem.kind}`;
  const params: Record<string, string> = { name: problem.name };
  if (problem.kind === "link_down") params.name = codeText(t, "link", problem.subject.id);
  for (const [name, value] of Object.entries(problem.data)) {
    const prefix =
      name === "reason"
        ? (PROBLEM_REASON_PREFIX[problem.kind] ?? "reason")
        : PROBLEM_CODE_PARAMS[name];
    params[name] = prefix === undefined ? value : codeText(t, prefix, value);
  }
  if (problem.data.roomId !== undefined) params.room = roomName(state, problem.data.roomId);
  if (problem.data.entities !== undefined)
    params.entities = problem.data.entities.split(",").join(", ");
  return isTextKey(key) ? t(key, params) : problem.kind;
}

export function renderProblems(state: StateView, t: Translate, offerEmpty = false): HTMLElement {
  const section = el("section", { class: "problems" });
  section.append(textElement("h2", t("problems.title")));
  if (state.problems.length === 0) {
    section.append(textElement("p", t("problems.none")));
  } else {
    const list = el("ul", {});
    for (const problem of state.problems) {
      list.append(
        el(
          "li",
          { class: `problem ${problem.severity}` },
          textElement("strong", `${t(`severity.${problem.severity}`)}: `),
          problemText(problem, state, t),
        ),
      );
    }
    section.append(list);
  }
  if (!state.ledgerReadable) {
    const box = el("div", { class: "originals" });
    if (state.configState === "empty") {
      box.append(textElement("p", t("originals.found", { count: state.originalsCopyRecords })));
    }
    box.append(
      textElement("p", t("originals.copy_records", { count: state.originalsCopyRecords })),
    );
    box.append(button(t("originals.import"), "import"));
    if (offerEmpty) {
      box.append(textElement("p", t("originals.no_copy")));
      box.append(button(t("originals.import_empty"), "import-empty"));
    }
    section.append(box);
  }
  return section;
}

function renderWrite(write: WriteView, valves: readonly ValveView[], t: Translate): HTMLElement {
  const modelId = valves.find((valve) => valve.valveId === write.valveId)?.modelId;
  const item = el("li", {}, textElement("strong", write.name));
  const list = el("ul", {});
  for (const change of write.settings) {
    const from = hidesDays(modelId) && isDaySetting(change.setting) ? undefined : change.from;
    list.append(
      textElement(
        "li",
        `${codeText(t, "setting", change.setting)}: ${formatValue(from, t)} → ${formatValue(change.to, t)}`,
      ),
    );
  }
  item.append(list);
  return item;
}

function renderPlanPending(pending: readonly PendingView[], t: Translate): HTMLElement {
  const list = el("ul", {});
  for (const entry of pending) {
    list.append(
      el(
        "li",
        {},
        textElement("strong", entry.name),
        textElement("span", ` — ${codeText(t, "pending.reason", entry.reason)}`),
      ),
    );
  }
  return list;
}

export function renderPlan(
  plan: PlanView,
  t: Translate,
  valves: readonly ValveView[],
): HTMLElement {
  const section = el("section", { class: "plan" });
  section.append(textElement("h3", t("plan.title")));
  section.append(textElement("p", t("plan.revision", { revision: plan.revision })));

  if (plan.joining.length > 0) {
    section.append(textElement("h4", t("plan.joining")));
    const list = el("ul", {});
    for (const joining of plan.joining) {
      const item = el("li", {}, textElement("strong", joining.name));
      const lines = el("ul", {});
      for (const original of joining.originals) {
        if (joining.unreadable.includes(original.setting)) continue;
        lines.append(
          textElement(
            "li",
            t("plan.original", {
              setting: codeText(t, "setting", original.setting),
              value: formatValue(original.value, t),
              evidence: codeText(t, "evidence", original.evidence),
            }),
          ),
        );
      }
      for (const setting of joining.unreadable) {
        lines.append(
          textElement("li", t("plan.unreadable", { setting: codeText(t, "setting", setting) })),
        );
      }
      item.append(lines);
      list.append(item);
    }
    section.append(list);
  }

  if (plan.pending.length > 0) {
    section.append(textElement("h4", t("plan.pending")));
    section.append(renderPlanPending(plan.pending, t));
  }

  section.append(textElement("h4", t("plan.writes")));
  if (plan.writes.length === 0) {
    section.append(textElement("p", t("plan.nothing")));
  } else {
    const list = el("ul", {});
    for (const write of plan.writes) list.append(renderWrite(write, valves, t));
    section.append(list);
  }
  section.append(textElement("p", plan.held ? t("plan.held") : t("plan.not_held")));
  return section;
}

/** Text params from an error's data: only texts and numbers, a list as its items. */
function errorParams(
  data: Readonly<Record<string, unknown>>,
  t: Translate,
): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(data)) {
    const prefix = name === "transport" ? "link" : name === "reason" ? "reason" : undefined;
    const part = (item: string): string =>
      prefix === undefined ? item : codeText(t, prefix, item);
    if (typeof value === "string") {
      params[name] =
        name === "settings"
          ? value
              .split(",")
              .map((s) => codeText(t, "setting", s))
              .join(", ")
          : part(value);
    } else if (typeof value === "number") {
      params[name] = value;
    } else if (typeof value === "boolean") {
      params[name] = String(value);
    }
  }
  return params;
}

function issueLines(error: ApiError): readonly string[] {
  const issues = error.data.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue: unknown) => {
    const fields =
      typeof issue === "object" && issue !== null ? (issue as Record<string, unknown>) : {};
    const field = (name: string): string => {
      const value = fields[name];
      return typeof value === "string" ? value : "";
    };
    return `${field("path")}: ${field("code")} — ${field("message")}`;
  });
}

function errorText(error: ApiError, t: Translate): string {
  const httpStatus = /^http_(\d+)$/.exec(error.code)?.[1];
  if (httpStatus !== undefined) return t("error.http", { status: Number(httpStatus) });
  const key = `error.${error.code}`;
  if (isTextKey(key)) return t(key, errorParams(error.data, t));
  return error.message === "" ? error.code : error.message;
}

export function renderError(error: ApiError, t: Translate): HTMLElement {
  const box = el("div", { class: "error", role: "alert" });
  box.append(textElement("p", errorText(error, t)));
  if (error.code === "config_invalid") {
    const list = el("ul", {});
    for (const line of issueLines(error)) list.append(textElement("li", line));
    box.append(list);
  }
  return box;
}

export function renderEditorControls(
  editor: EditorState,
  state: StateView | undefined,
  busy: boolean,
  t: Translate,
): HTMLElement {
  const controls = el("div", { class: "editor-controls" });
  const preview = button(t("editor.preview"), "preview");
  preview.disabled = busy;
  const apply = button(t("editor.apply"), "apply");
  apply.disabled = busy || !canApply(editor);
  const reload = button(t("editor.reload"), "reload");
  controls.append(preview, apply, reload);

  if (state?.configState === "unreadable") {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = editor.overwrite;
    box.dataset.action = "overwrite";
    controls.append(el("label", {}, box, t("editor.overwrite")));
  }
  if (editor.dirty) controls.append(textElement("p", t("editor.dirty"), { class: "notice" }));
  if (editor.serverChanged) {
    controls.append(textElement("p", t("editor.server_changed"), { class: "notice" }));
  }
  if (editor.appliedRevision !== undefined) {
    controls.append(
      textElement("p", t("editor.applied", { revision: editor.appliedRevision }), {
        class: "notice",
      }),
    );
  }
  return controls;
}
