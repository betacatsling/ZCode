import * as React from "react";
import { createRoot } from "react-dom/client";
import type { HarnessCatalogEntry } from "@zcode/shared/agent-host";
import { HarnessIcon } from "../src/agent-host/HarnessIcon.js";
import type { HarnessAssetDescriptor } from "../src/agent-host/harnessAssetResolver.js";
import "@zcode/ui/styles.css";

const lightPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const darkPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg==";
const brokenPng = lightPng.slice(0, 36);
const catalog: HarnessCatalogEntry[] = [
  {
    manifest: {
      schemaVersion: 1,
      id: "pi",
      name: "Pi",
      adapterVersion: "1",
      icon: { light: "builtin:light", dark: "builtin:dark" },
    },
    availability: "supported",
  },
];
function Fixture() {
  const [theme, setTheme] = React.useState<"light" | "dark">("light");
  const [mode, setMode] = React.useState("valid");
  const [model, setModel] = React.useState("model1");
  const resolve = (_id: string): HarnessAssetDescriptor | undefined => {
    if (mode === "missing") return undefined;
    if (mode === "throw") throw new Error("resolver offline");
    if (mode === "url")
      return {
        kind: "url",
        url: "https://evil.test/icon.png",
      } as unknown as HarnessAssetDescriptor;
    if (mode === "svg")
      return {
        kind: "trusted-png",
        mimeType: "image/svg+xml",
        base64: btoa('<svg onload="alert(1)"/>'),
      } as HarnessAssetDescriptor;
    if (mode === "oversized")
      return { kind: "trusted-png", mimeType: "image/png", base64: "A".repeat(350000) };
    return {
      kind: "trusted-png",
      mimeType: "image/png",
      base64: mode === "broken" ? brokenPng : _id === "builtin:dark" ? darkPng : lightPng,
    };
  };
  return (
    <main className="bg-background p-4 text-foreground text-ui-base">
      <button onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Theme</button>
      <button onClick={() => setModel(model === "model1" ? "model2" : "model1")}>Model</button>
      <output data-testid="model">{model}</output>
      {(["valid", "missing", "url", "svg", "oversized", "broken", "throw"] as const).map(
        (value) => (
          <button key={value} onClick={() => setMode(value)}>
            {value}
          </button>
        ),
      )}
      <HarnessIcon harnessId="pi" catalog={catalog} theme={theme} resolveIconAsset={resolve} />
      <HarnessIcon harnessId="unknown" catalog={catalog} theme={theme} resolveIconAsset={resolve} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
