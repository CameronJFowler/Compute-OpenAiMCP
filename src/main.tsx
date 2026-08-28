import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./ui/App";
import { useWorkspace } from "./state/workspace";
import { getHostFlavour, getModelContext, waitForHost } from "./webmcp/host";
import { invalidateToolSet, startRegistry, syncTools } from "./webmcp/registry";

/**
 * Boot.
 *
 * The registry starts whether or not a WebMCP host exists. It keeps its own
 * list of intended tools and publishes it to the store, so the page is honest
 * and usable in a browser that has never heard of WebMCP - which today is most
 * of them.
 *
 * Host detection is deliberately patient. An agent browser can inject
 * modelContext after the document has started executing, and the page may be
 * opened in a background tab and only activated later, so we poll for a while
 * and re-probe whenever the tab becomes visible or regains focus. A missed
 * injection means the agent sees no tools at all, which is the one failure
 * mode worth spending a few timers on.
 */
function reportHostStatus(): void {
  const store = useWorkspace.getState();
  if (getModelContext()) {
    const flavour = getHostFlavour();
    store.setWebmcpStatus({
      kind: "ready",
      entryPoint: flavour === "navigator" ? "navigator" : "document",
    });
    return;
  }
  store.setWebmcpStatus({
    kind: "unavailable",
    reason: window.isSecureContext
      ? "no document.modelContext or navigator.modelContext"
      : "not a secure context",
  });
}

function adoptHost(): void {
  reportHostStatus();
  invalidateToolSet();
  void syncTools();
}

startRegistry();
reportHostStatus();

// Patient first pass.
waitForHost(adoptHost, 30000);

// And a re-probe whenever the tab wakes up, in case the host arrived while it
// was hidden and the poll had already given up.
const reprobe = () => {
  if (document.visibilityState !== "visible") return;
  if (useWorkspace.getState().webmcpStatus.kind === "ready") return;
  if (getModelContext()) adoptHost();
};
document.addEventListener("visibilitychange", reprobe);
window.addEventListener("focus", reprobe);

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
