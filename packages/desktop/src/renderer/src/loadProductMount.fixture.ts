/* Opt-in Desktop composition: production MessagePort connector and platform adapter;
 * the UI fixture receives only the public service/platform contracts. */
import { connectViaMessagePort } from "@zcode/client";
import { InternalChannels } from "@zcode/shared";
import { mountLoadProductFixture } from "@zcode/ui/load-product-mount-fixture";
import { createDesktopPlatform } from "./desktopPlatform.js";

const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: true });
let attached = false;
window.addEventListener("message", (event) => {
  if (
    attached ||
    event.source !== window ||
    event.data?.type !== InternalChannels.ServicePort ||
    !event.ports[0]
  )
    return;
  attached = true;
  mountLoadProductFixture(connectViaMessagePort(event.ports[0]), platform);
});
