#!/usr/bin/env node
"use strict";

// Launches the browser service for `npm run dev` at the repo root. The
// single-command dev workflow (concurrently starting the renderer and this
// service as sibling processes) has no equivalent of apps/desktop's Electron
// main process, which is what normally mints BROWSER_SERVICE_TOKEN and
// injects it into this service's environment. Without it, every
// X-Service-Token this service receives is checked against an unset
// expected token and every authenticated route 401s (see
// src/browser_service/auth.py). Falls back to the same "local-dev-token"
// value documented in the README's manual Terminal-1 instructions and
// already used as the renderer's dev-only default (apps/renderer/.env), so
// both processes agree on one token without a developer wiring it by hand.
// An already-set BROWSER_SERVICE_TOKEN (e.g. exported manually, or by a
// future desktop-launched dev flow) is left untouched.
//
// Deliberately omits uvicorn's --reload here: on win32, uvicorn's reload
// supervisor runs the app in a worker process built with `use_subprocess:
// true` (see .venv/Lib/site-packages/uvicorn/loops/asyncio.py), which
// selects asyncio.SelectorEventLoop instead of the Proactor loop Windows
// normally defaults to. SelectorEventLoop cannot spawn subprocesses on
// Windows (asyncio.base_events._make_subprocess_transport raises
// NotImplementedError), so every browser.explore_website /
// navigate_and_extract call -- which need nodriver to launch a real Chrome
// subprocess -- fails as soon as it tries to start a browser. Running
// without --reload keeps this service on Windows' default Proactor loop.

const { spawn } = require("node:child_process");
const path = require("node:path");

const env = { ...process.env };
if (!env.BROWSER_SERVICE_TOKEN || env.BROWSER_SERVICE_TOKEN.trim() === "") {
  env.BROWSER_SERVICE_TOKEN = "local-dev-token";
}

const port = env.BROWSER_SERVICE_DEV_PORT || "8020";
const reloadArgs = process.platform === "win32" ? [] : ["--reload"];
const child = spawn(
  "uv",
  ["run", "uvicorn", "browser_service.app:app", ...reloadArgs, "--port", port],
  {
    cwd: path.join(__dirname, ".."),
    env,
    stdio: "inherit",
    shell: true,
  },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
