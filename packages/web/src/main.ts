import "./style.css";
import { apiBase, createClient, eventsUrl } from "./api.ts";
import { mount } from "./app.ts";
import type { AppDeps } from "./app.ts";
import { connectEvents } from "./events.ts";

/** `localStorage` itself can throw in a sandboxed frame; the app also ignores a throwing storage. */
function pageStorage(): AppDeps["storage"] {
  return {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => {
      localStorage.setItem(key, value);
    },
  };
}

const root = document.getElementById("app");
if (root !== null) {
  const base = apiBase(location.pathname);
  const url = eventsUrl(location.href);
  mount(root, {
    client: createClient(base, (input, init) => fetch(input, init)),
    connect: (handlers) =>
      connectEvents(url, handlers, {
        open: (address) => new WebSocket(address),
        setTimer: (run, ms) => setTimeout(run, ms),
        clearTimer: (handle) => {
          clearTimeout(handle as ReturnType<typeof setTimeout>);
        },
      }),
    storage: pageStorage(),
    browserLanguages: navigator.languages,
    confirm: (text) => window.confirm(text),
  });
}
