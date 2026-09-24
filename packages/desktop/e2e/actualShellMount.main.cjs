// Disposable RED Electron shell entry. Production renderer + preload, but deliberately no Host
// attachment yet; the joined test must not pass on the independent Core and browser legs.
if (process.env.ZCODE_ACTUAL_SHELL_FIXTURE !== "1" || !process.env.ZCODE_ACTUAL_CORE_LOCATION || !process.env.ZCODE_DESKTOP_USER_DATA_DIR) {
  throw new Error("Owned isolated actual-Shell fixture required");
}
const { app, BrowserWindow, session } = require("electron");
const { join } = require("node:path");
app.setPath("userData", process.env.ZCODE_DESKTOP_USER_DATA_DIR);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    const url = new URL(request.url);
    callback({ cancel: !(["file:", "data:", "devtools:"].includes(url.protocol) ||
      (url.hostname === "127.0.0.1" && ["http:", "https:", "ws:"].includes(url.protocol))) });
  });
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: join(__dirname, "../out/preload/index.cjs"), contextIsolation: true, nodeIntegration: false,
  } });
  await window.loadFile(join(__dirname, "../out/renderer/index.html"), { query: {
    restoreSession: "false", supportsSettings: "false", initialWorkspacePath: process.env.ZCODE_ACTUAL_WORKSPACE_PATH,
  } });
});
app.on("window-all-closed", () => app.quit());
