import type { ApiError, ApplyRequest, ConfigView, PlanView } from "@heatmaster/core";

export type EditorState = Readonly<{
  text: string;
  baseRevision: number;
  dirty: boolean;
  previewedText: string | undefined;
  plan: PlanView | undefined;
  error: ApiError | undefined;
  accept: readonly string[];
  overwrite: boolean;
  serverChanged: boolean;
  appliedRevision: number | undefined;
}>;

/** The server's text, not dirty. */
export function loaded(config: ConfigView): EditorState {
  return {
    text: config.yaml,
    baseRevision: config.revision,
    dirty: false,
    previewedText: undefined,
    plan: undefined,
    error: undefined,
    accept: [],
    overwrite: false,
    serverChanged: false,
    appliedRevision: undefined,
  };
}

/** An empty text at that revision, with the error shown. */
export function loadFailed(revision: number, error: ApiError): EditorState {
  return { ...loaded({ revision, config: {}, yaml: "" }), error };
}

/** A change of the inputs drops the plan and the error: a new preview is needed. */
function changed(state: EditorState, fields: Partial<EditorState>): EditorState {
  return {
    ...state,
    previewedText: undefined,
    plan: undefined,
    error: undefined,
    appliedRevision: undefined,
    ...fields,
  };
}

export function edited(state: EditorState, text: string): EditorState {
  return changed(state, { text, dirty: true });
}

export function acceptToggled(state: EditorState, valveId: string, on: boolean): EditorState {
  const others = state.accept.filter((id) => id !== valveId);
  return changed(state, { accept: on ? [...others, valveId] : others });
}

export function overwriteToggled(state: EditorState, on: boolean): EditorState {
  return changed(state, { overwrite: on });
}

export function previewed(state: EditorState, plan: PlanView): EditorState {
  return { ...state, plan, previewedText: state.text, error: undefined };
}

export function applied(state: EditorState, plan: PlanView): EditorState {
  return {
    ...state,
    baseRevision: plan.revision,
    dirty: false,
    previewedText: undefined,
    plan: undefined,
    error: undefined,
    accept: [],
    overwrite: false,
    serverChanged: false,
    appliedRevision: plan.revision,
  };
}

/** Keeps the text and the switches, drops the plan. */
export function refused(state: EditorState, error: ApiError): EditorState {
  return { ...state, plan: undefined, previewedText: undefined, error, appliedRevision: undefined };
}

/** The user's text is never replaced without their say. */
export function serverRevision(
  state: EditorState,
  revision: number,
): Readonly<{ state: EditorState; reload: boolean }> {
  if (revision === state.baseRevision) return { state, reload: false };
  if (!state.dirty) return { state, reload: true };
  return { state: { ...state, serverChanged: true }, reload: false };
}

/** Apply sends exactly what was previewed. */
export function canApply(state: EditorState): boolean {
  return (
    state.plan !== undefined && state.previewedText === state.text && state.error === undefined
  );
}

export function request(state: EditorState): ApplyRequest {
  return {
    yaml: state.text,
    expectedRevision: state.baseRevision,
    acceptUnknownOriginals: state.accept,
    overwriteUnreadable: state.overwrite,
  };
}

/** The valve named by an `originals_unreadable` error, plus those already accepted. */
export function acceptOffers(state: EditorState): readonly string[] {
  const offered =
    state.error?.code === "originals_unreadable" && typeof state.error.data.valveId === "string"
      ? [state.error.data.valveId]
      : [];
  return [...new Set([...offered, ...state.accept])];
}
