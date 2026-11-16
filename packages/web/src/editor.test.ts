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
import { apiError, configView, planView } from "../test/builders.ts";

const clean = () => loaded(configView({ revision: 3, yaml: "a: 1\n" }));
const withPlan = () => previewed(edited(clean(), "a: 2\n"), planView({ revision: 4 }));

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
      const state = applied(
        overwriteToggled(acceptToggled(withPlan(), "z2m:a", true), true),
        planView({ revision: 5 }),
      );
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
