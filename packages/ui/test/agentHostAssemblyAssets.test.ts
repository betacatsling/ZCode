import assert from "node:assert/strict";
import { test } from "node:test";
import { safeIconUrl } from "../src/agent-host/HarnessIcon.js";
import type { HarnessAssetDescriptor } from "../src/agent-host/harnessAssetResolver.js";
import type { ProjectSidebarProps } from "../src/project-sidebar/types.js";
import type { AgentHostConversationPort } from "@zcode/ui";
import type { IAgentHostService } from "@zcode/services";

// 编译期校验真实 Host 服务可直接作为 facade 端口；不能靠 cast 隐藏缺失的方法。
const acceptHostPort = (host: IAgentHostService): AgentHostConversationPort => host;
void acceptHostPort;

test("sidebar mixed icon port never treats a harness PNG descriptor as a Project URL", () => {
  const png: HarnessAssetDescriptor = {
    kind: "trusted-png",
    mimeType: "image/png",
    base64: "invalid",
  };
  const resolveIconAsset: ProjectSidebarProps["resolveIconAsset"] = (id) =>
    id === "harness" ? png : "/project-icon.png";
  assert.equal(safeIconUrl("harness", resolveIconAsset), undefined);
  assert.equal(safeIconUrl("project", resolveIconAsset), "/project-icon.png");
});
