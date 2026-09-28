const mode = process.env.CERTIFY_NATIVE_MODE?.trim() || "fake";

if (mode === "fake") {
  const { runNativeV4Fake } = await import("./certifyNativeV4Fake.js");
  await runNativeV4Fake();
} else if (mode === "live") {
  const { runNativeV4Live } = await import("./certifyNativeV4Live.js");
  await runNativeV4Live();
} else {
  throw new Error(`Unknown CERTIFY_NATIVE_MODE: ${mode}`);
}
