import { describe, expect, it } from "vitest";
import {
  acceptOffers,
  acceptToggled,
  applied,
  canApply,
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
import { apiError, configView, planView } from "../test/builders.ts";

const clean = () => loaded(configView({ revision: 3, yaml: "a: 1\n" }));
/** Previews the state's own request. */
const previewOf = (state: EditorState, plan = planView({ revision: 4 })) =>
  previewed(state, request(state), plan);
const withPlan = () => previewOf(edited(clean(), "a: 2\n"));

describe("editor", () => {
  describe("loaded", () => {
    describe("Always", () => {
      it("holds the server's YAML and revision, not dirty, with no plan", () => {
        const state = clean();
        expect(state.text).toBe("a: 1\n");
        expect(state.baseRevision).toBe(3);
        expect(state.dirty).toBe(false);
        expect(state.plan).toBeUndefined();
      });
    });
  });

  describe("loadFailed", () => {
    describe("Always", () => {
      it("holds an empty text, the given revision and the error", () => {
        const error = apiError("config_unreadable");
        const state = loadFailed(7, error);
        expect(state.text).toBe("");
        expect(state.baseRevision).toBe(7);
        expect(state.error).toEqual(error);
      });
    });
  });

  describe("edited", () => {
    describe("After a preview", () => {
      it("dirty is true and the plan is dropped", () => {
        const state = edited(withPlan(), "a: 3\n");
        expect(state.dirty).toBe(true);
        expect(state.plan).toBeUndefined();
        expect(state.text).toBe("a: 3\n");
      });
      it("canApply is false", () => {
        expect(canApply(edited(withPlan(), "a: 3\n"))).toBe(false);
      });
    });
  });

  describe("previewed", () => {
    describe("With the current text", () => {
      it("canApply is true", () => {
        expect(canApply(withPlan())).toBe(true);
      });
    });
    describe("With the text edited after the request was sent", () => {
      const before = edited(clean(), "a: 2\n");
      const state = previewed(edited(before, "a: 3\n"), request(before), planView());
      it("the plan is not kept and canApply is false", () => {
        expect(state.plan).toBeUndefined();
        expect(canApply(state)).toBe(false);
      });
      it("the newer text is kept and stays dirty", () => {
        expect(state.text).toBe("a: 3\n");
        expect(state.dirty).toBe(true);
      });
    });
    describe("With a switch toggled after the request was sent", () => {
      it("the plan is not kept and canApply is false", () => {
        const before = edited(clean(), "a: 2\n");
        const state = previewed(overwriteToggled(before, true), request(before), planView());
        expect(state.plan).toBeUndefined();
        expect(canApply(state)).toBe(false);
      });
    });
  });

  describe("canApply", () => {
    describe("With a plan whose previewed text differs from the text", () => {
      it("is false", () => {
        const state = { ...withPlan(), text: "other" };
        expect(canApply(state)).toBe(false);
      });
    });
    describe("With an error", () => {
      it("is false", () => {
        const state = { ...withPlan(), error: apiError("x") };
        expect(canApply(state)).toBe(false);
      });
    });
  });

  describe("acceptToggled / overwriteToggled", () => {
    describe("After a preview", () => {
      it("the switch is stored and the plan is dropped", () => {
        const accepted = acceptToggled(withPlan(), "z2m:a", true);
        expect(accepted.accept).toEqual(["z2m:a"]);
        expect(accepted.plan).toBeUndefined();
        const overwritten = overwriteToggled(withPlan(), true);
        expect(overwritten.overwrite).toBe(true);
        expect(overwritten.plan).toBeUndefined();
      });
    });
    describe("With a valve turned on and then off", () => {
      it("accept is empty again", () => {
        const state = acceptToggled(acceptToggled(clean(), "z2m:a", true), "z2m:a", false);
        expect(state.accept).toEqual([]);
      });
    });
  });

  describe("request", () => {
    describe("Always", () => {
      it("holds the text as yaml, the base revision, the accepted valves and the overwrite switch", () => {
        const state = overwriteToggled(acceptToggled(clean(), "z2m:a", true), true);
        expect(request(state)).toEqual({
          yaml: "a: 1\n",
          expectedRevision: 3,
          acceptUnknownOriginals: ["z2m:a"],
          overwriteUnreadable: true,
        });
      });
    });
  });

  describe("refused", () => {
    describe("With originals_unreadable naming a valve", () => {
      it("the text is kept, the plan is dropped and acceptOffers lists that valve", () => {
        const state = refused(withPlan(), apiError("originals_unreadable", { valveId: "z2m:b" }));
        expect(state.text).toBe("a: 2\n");
        expect(state.plan).toBeUndefined();
        expect(acceptOffers(state)).toEqual(["z2m:b"]);
      });
      it("keeps a valve that was already accepted in the offers", () => {
        const state = refused(
          acceptToggled(clean(), "z2m:a", true),
          apiError("originals_unreadable", { valveId: "z2m:b" }),
        );
        expect(acceptOffers(state)).toEqual(["z2m:b", "z2m:a"]);
      });
    });
    describe("With revision_conflict", () => {
      it("the text is kept and the error is held", () => {
        const error = apiError("revision_conflict", { expected: "3", current: "4" });
        const state = refused(withPlan(), error);
        expect(state.text).toBe("a: 2\n");
        expect(state.error).toEqual(error);
      });
    });
  });

  describe("applied", () => {
    describe("With a plan of revision 5", () => {
      const sentState = overwriteToggled(acceptToggled(withPlan(), "z2m:a", true), true);
      const state = applied(sentState, request(sentState), planView({ revision: 5 }));
      it("baseRevision is 5, dirty is false, the plan is dropped and appliedRevision is 5", () => {
        expect(state.baseRevision).toBe(5);
        expect(state.dirty).toBe(false);
        expect(state.plan).toBeUndefined();
        expect(state.appliedRevision).toBe(5);
      });
      it("accept is empty and overwrite is false", () => {
        expect(state.accept).toEqual([]);
        expect(state.overwrite).toBe(false);
      });
    });
    describe("With the text edited after the request was sent", () => {
      const sentState = withPlan();
      const state = applied(
        edited(sentState, "a: 3\n"),
        request(sentState),
        planView({ revision: 5 }),
      );
      it("the newer text is kept and stays dirty", () => {
        expect(state.text).toBe("a: 3\n");
        expect(state.dirty).toBe(true);
      });
      it("baseRevision and appliedRevision are 5, the plan is dropped and canApply is false", () => {
        expect(state.baseRevision).toBe(5);
        expect(state.appliedRevision).toBe(5);
        expect(state.plan).toBeUndefined();
        expect(canApply(state)).toBe(false);
      });
      it("a state message with revision 5 does not reload it", () => {
        expect(serverRevision(state, 5).reload).toBe(false);
        expect(serverRevision(state, 5).state.text).toBe("a: 3\n");
      });
    });
  });

  describe("serverRevision", () => {
    describe("With the same revision", () => {
      it("nothing changes and reload is false", () => {
        const state = clean();
        expect(serverRevision(state, 3)).toEqual({ state, reload: false });
      });
    });
    describe("With another revision and a clean editor", () => {
      it("reload is true", () => {
        expect(serverRevision(clean(), 4).reload).toBe(true);
      });
    });
    describe("With another revision and a dirty editor", () => {
      it("reload is false, serverChanged is true and the text is kept", () => {
        const result = serverRevision(edited(clean(), "mine"), 4);
        expect(result.reload).toBe(false);
        expect(result.state.serverChanged).toBe(true);
        expect(result.state.text).toBe("mine");
      });
    });
  });
});
