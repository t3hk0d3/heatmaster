import type { ApiError, ConfigView, PlanView, StateView } from "@heatmaster/core";
import type { ApiClient, Result } from "./api.ts";
import {
  acceptToggled,
  applied,
  edited,
  loadFailed,
  loaded,
  overwriteToggled,
  previewed,
  refused,
  request,
  serverRevision,
} from "./editor.ts";
import type { EditorState } from "./editor.ts";
import type { ConnectionStatus } from "./events.ts";
import { LANGUAGE_KEY, isLanguage, pickLanguage, translator } from "./i18n.ts";
import type { Language } from "./i18n.ts";
import {
  renderEditorControls,
  renderError,
  renderHeader,
  renderOtherValves,
  renderPlan,
  renderProblems,
  renderRooms,
} from "./render.ts";

export type AppDeps = Readonly<{
  client: ApiClient;
  connect(
    handlers: Readonly<{
      onState(state: StateView): void;
      onStatus(status: ConnectionStatus): void;
    }>,
  ): Readonly<{ close(): void }>;
  storage: Pick<Storage, "getItem" | "setItem">;
  browserLanguages: readonly string[];
  confirm(text: string): boolean;
}>;

const NO_CONFIG: ConfigView = { revision: 0, config: {}, yaml: "" };

function readStored(storage: AppDeps["storage"]): string | null {
  try {
    return storage.getItem(LANGUAGE_KEY);
  } catch {
    return null;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  created.className = className;
  return created;
}

export function mount(root: HTMLElement, deps: AppDeps): Readonly<{ stop(): void }> {
  const { client } = deps;
  const document = root.ownerDocument;

  let language: Language = pickLanguage(readStored(deps.storage), deps.browserLanguages);
  let state: StateView | undefined;
  let status: ConnectionStatus = "connecting";
  let editor: EditorState = loaded(NO_CONFIG);
  let configLoaded = false;
  let reloading = false;
  let busy = false;
  let stopped = false;
  /** A function, so that the compiler does not take `stopped` as unchanged across an await. */
  const halted = (): boolean => stopped;
  let offerEmpty = false;
  let actionError: ApiError | undefined;
  /** The failure of the first state read. A state message proves it is over, so it clears it. */
  let startError: ApiError | undefined;
  /** The config read failed for a reason that passes (starting, no network): read it again. */
  let retryConfig = false;

  const headerBox = element(document, "div", "header-box");
  const noticeBox = element(document, "div", "notice-box");
  const roomsBox = element(document, "div", "rooms-box");
  const othersBox = element(document, "div", "others-box");
  const problemsBox = element(document, "div", "problems-box");
  const editorSection = element(document, "section", "editor");
  const editorTitle = document.createElement("h2");
  const textarea = document.createElement("textarea");
  textarea.spellcheck = false;
  textarea.rows = 24;
  const controlsBox = element(document, "div", "controls-box");
  const planBox = element(document, "div", "plan-box");
  const editorErrorBox = element(document, "div", "editor-error-box");
  editorSection.append(editorTitle, textarea, controlsBox, planBox, editorErrorBox);
  const main = document.createElement("main");
  main.append(noticeBox, roomsBox, othersBox, problemsBox, editorSection);
  root.replaceChildren(headerBox, main);

  function render(): void {
    const t = translator(language);
    document.documentElement.lang = language;
    headerBox.replaceChildren(renderHeader(state, status, language, t));
    noticeBox.replaceChildren(
      ...(state === undefined ? [renderPlaceholder(t("app.loading"))] : []),
      ...(startError === undefined ? [] : [renderError(startError, t)]),
      ...(actionError === undefined ? [] : [renderError(actionError, t)]),
    );
    if (state === undefined) {
      roomsBox.replaceChildren();
      othersBox.replaceChildren();
      problemsBox.replaceChildren();
    } else {
      roomsBox.replaceChildren(renderRooms(state, language, t));
      othersBox.replaceChildren(renderOtherValves(state, t));
      problemsBox.replaceChildren(renderProblems(state, t, offerEmpty));
    }
    editorTitle.textContent = t("editor.title");
    textarea.setAttribute("aria-label", t("editor.title"));
    if (textarea.value !== editor.text) textarea.value = editor.text;
    controlsBox.replaceChildren(renderEditorControls(editor, state, busy, t));
    planBox.replaceChildren(
      ...(editor.plan === undefined ? [] : [renderPlan(editor.plan, t, state?.valves ?? [])]),
    );
    editorErrorBox.replaceChildren(
      ...(editor.error === undefined ? [] : [renderError(editor.error, t)]),
    );
    if (busy) {
      for (const control of root.querySelectorAll("button, input")) {
        if (control instanceof HTMLElement && control.dataset.action !== "language") {
          control.setAttribute("disabled", "");
        }
      }
    }
  }

  function renderPlaceholder(text: string): HTMLElement {
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    return paragraph;
  }

  async function loadConfig(): Promise<void> {
    if (reloading) return;
    reloading = true;
    const result = await client.config();
    reloading = false;
    if (halted()) return;
    // Text typed while the read was in flight is the user's; the read only flags the difference.
    if (editor.dirty) editor = result.ok ? { ...editor, serverChanged: true } : editor;
    else editor = result.ok ? loaded(result.value) : loadFailed(state?.revision ?? 0, result.error);
    configLoaded = true;
    retryConfig =
      !result.ok &&
      (result.error.code === "not_ready" ||
        result.error.code === "network" ||
        result.error.code.startsWith("http_"));
    render();
  }

  /** Runs one request at a time; the action buttons stay disabled while it runs. */
  async function run<T>(call: () => Promise<Result<T>>): Promise<Result<T> | undefined> {
    if (busy || halted()) return undefined;
    busy = true;
    render();
    try {
      return await call();
    } finally {
      busy = false;
      if (!halted()) render();
    }
  }

  /** After a hold call a stale `holdWrites` in the editor must not undo the button unnoticed. */
  async function afterHold(): Promise<void> {
    if (editor.dirty) {
      editor = { ...editor, serverChanged: true };
      render();
    } else {
      await loadConfig();
    }
  }

  function report(result: Result<unknown> | undefined): boolean {
    if (result === undefined) return false;
    actionError = result.ok ? undefined : result.error;
    return result.ok;
  }

  async function setHold(on: boolean): Promise<void> {
    if (!on && !deps.confirm(translator(language)("header.release_question"))) return;
    if (report(await run(() => client.hold(on)))) await afterHold();
    else if (!halted()) render();
  }

  async function valveAction(action: string, valveId: string): Promise<void> {
    if (action === "forget") {
      const name = state?.valves.find((valve) => valve.valveId === valveId)?.name ?? valveId;
      if (!deps.confirm(translator(language)("valve.forget_question", { name }))) return;
    }
    const result = await run(() =>
      action === "refresh"
        ? client.refresh(valveId)
        : action === "restore"
          ? client.restore(valveId)
          : client.forget(valveId),
    );
    report(result);
    if (!halted()) render();
  }

  async function importOriginals(acceptEmpty: boolean): Promise<void> {
    if (acceptEmpty && !deps.confirm(translator(language)("originals.import_empty_question"))) {
      return;
    }
    const result = await run(() => client.importOriginals(acceptEmpty));
    if (report(result)) offerEmpty = false;
    else if (result !== undefined && !result.ok && result.error.code === "no_originals_copy") {
      offerEmpty = true;
    }
    if (!halted()) render();
  }

  async function changePlan(apply: boolean): Promise<void> {
    const sent = request(editor);
    const result = await run<PlanView>(() => (apply ? client.apply(sent) : client.preview(sent)));
    if (result === undefined || halted()) return;
    if (!result.ok) editor = refused(editor, result.error);
    else {
      editor = apply ? applied(editor, sent, result.value) : previewed(editor, sent, result.value);
    }
    render();
  }

  function setLanguage(next: Language): void {
    language = next;
    try {
      deps.storage.setItem(LANGUAGE_KEY, next);
    } catch {
      // A storage that cannot be written is ignored; the page still switches.
    }
    render();
  }

  function onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest("button[data-action]");
    if (!(control instanceof HTMLButtonElement) || control.disabled) return;
    const action = control.dataset.action ?? "";
    const valveId = control.dataset.valveId ?? "";
    switch (action) {
      case "hold":
        void setHold(true);
        break;
      case "release":
        void setHold(false);
        break;
      case "refresh":
      case "restore":
      case "forget":
        void valveAction(action, valveId);
        break;
      case "import":
        void importOriginals(false);
        break;
      case "import-empty":
        void importOriginals(true);
        break;
      case "preview":
        void changePlan(false);
        break;
      case "apply":
        void changePlan(true);
        break;
      case "reload":
        void run(() => client.config()).then((result) => {
          if (result === undefined || halted()) return;
          editor = result.ok ? loaded(result.value) : loadFailed(editor.baseRevision, result.error);
          render();
        });
        break;
      case "language": {
        const next = control.dataset.language;
        if (isLanguage(next)) setLanguage(next);
        break;
      }
      default:
        break;
    }
  }

  function onChange(event: Event): void {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
    if (target.dataset.action === "accept") {
      editor = acceptToggled(editor, target.dataset.valveId ?? "", target.checked);
    } else if (target.dataset.action === "overwrite") {
      editor = overwriteToggled(editor, target.checked);
    } else {
      return;
    }
    render();
  }

  function onInput(event: Event): void {
    if (event.target !== textarea) return;
    editor = edited(editor, textarea.value);
    render();
  }

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  textarea.addEventListener("input", onInput);

  let eventSeen = false;
  const events = deps.connect({
    onState(next) {
      if (halted()) return;
      eventSeen = true;
      state = next;
      startError = undefined;
      if (configLoaded) {
        const checked = serverRevision(editor, next.revision);
        editor = checked.state;
        if (checked.reload || (retryConfig && !editor.dirty)) void loadConfig();
      }
      render();
    },
    onStatus(next) {
      if (halted()) return;
      status = next;
      render();
    },
  });

  render();
  void client.state().then((result) => {
    if (halted()) return;
    if (result.ok) {
      if (!eventSeen) state = result.value;
    } else {
      startError = result.error;
    }
    render();
  });
  void loadConfig();

  return {
    stop() {
      stopped = true;
      events.close();
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      textarea.removeEventListener("input", onInput);
    },
  };
}
