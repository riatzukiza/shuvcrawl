import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const server = join(process.cwd(), "node_modules/patchright-core/lib/server");
const chromium = join(server, "chromium");
const frameModulePath = join(chromium, "crPage.js");
const dependencyRequire = createRequire(frameModulePath);
const { CRSession } = dependencyRequire("./crConnection.js");
const frameModule = { exports: {} };
const source = readFileSync(frameModulePath, "utf8");
// Expose the installed private class for this process without editing the dependency.
new Function("require", "module", "exports", "__filename", "__dirname", `${source}\nmodule.exports.FrameSession = FrameSession;`)(
  dependencyRequire,
  frameModule,
  frameModule.exports,
  frameModulePath,
  dirname(frameModulePath),
);
const { FrameSession } = frameModule.exports;
assert.equal(typeof FrameSession.prototype._initialize, "function");

function createFixture() {
  const messageIds = new Map();
  let nextId = 0;
  const connection = {
    _sessions: new Map(),
    _closed: false,
    _rawSend(_sessionId, method) {
      const id = ++nextId;
      messageIds.set(method, id);
      return id;
    },
  };
  const session = new CRSession(connection, null, "initializing-page");
  connection._sessions.set("initializing-page", session);
  const frame = {
    _client: session,
    _page: { isStorageStatePage: false },
    _crPage: {
      _browserContext: {
        _browser: { isClank: () => false, options: { headful: true } },
        _options: { noDefaultViewport: false },
        needsPlaywrightBinding: () => false,
        initScripts: [],
      },
      _networkManager: { addSession: async () => {} },
      _page: { allBindings: () => [], initScripts: [] },
    },
    _isMainFrame: () => false,
    _addRendererListeners() {},
    _addBrowserListeners() {},
    _updateGeolocation: async () => {},
    _updateEmulateMedia: async () => {},
    _updateFileChooserInterception: async () => {},
    _firstNonInitialNavigationCommittedPromise: Promise.resolve(),
  };
  const outcome = FrameSession.prototype._initialize.call(frame, true)
    .then(() => ({ success: true }), error => ({ success: false, error }));
  assert(messageIds.get("Page.enable"), "Pinned dependency must issue Page.enable first");
  assert(messageIds.get("Browser.getWindowForTarget"), "Window command must be pending");
  return { messageIds, outcome, session };
}

test("Page.enable rejection stays inside the initializing browser session", async () => {
  const detached = "Internal server error, session closed.";
  const CDP_FAILURE = "Controlled Page.enable failure";
  const escaped = [];
  const observeUnhandled = error => escaped.push({ method: error.method, message: error.message });
  process.on("unhandledRejection", observeUnhandled);

  try {
    const first = createFixture();
    first.session.dispose();
    const firstOutcome = await first.outcome;
    assert.equal(firstOutcome.success, false);
    assert.equal(firstOutcome.error.method, "Browser.getWindowForTarget");
    assert(firstOutcome.error.message.endsWith(detached));
    await delay(25);

    const second = createFixture();
    second.session._onMessage({
      id: second.messageIds.get("Page.enable"),
      error: { code: -32000, message: CDP_FAILURE },
    });
    await delay(25);
    second.session._onMessage({
      id: second.messageIds.get("Browser.getWindowForTarget"),
      result: { windowId: 1 },
    });
    const secondOutcome = await second.outcome;
    assert.equal(secondOutcome.success, false);
    assert.equal(secondOutcome.error.method, "Page.enable");
    assert(secondOutcome.error.message.endsWith(CDP_FAILURE));
    second.session.dispose();
    await delay(25);
  } finally {
    process.off("unhandledRejection", observeUnhandled);
  }

  assert.deepEqual(escaped, [], "Page.enable rejection escaped frame initialization");
});
