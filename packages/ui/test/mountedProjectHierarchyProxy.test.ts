import assert from "node:assert/strict";
import { test } from "node:test";
import type { IServiceAccessor } from "@zcode/services";
import { hasMountedHierarchy } from "../src/hooks/useMountedProjectSidebar.js";

test("mounted hierarchy recognizes the public RPC Proxy service accessor", () => {
  const callable = new Proxy(
    {},
    {
      get(_target, property) {
        return typeof property === "string" ? async () => undefined : undefined;
      },
    },
  );
  assert.equal("sidebarSnapshot" in callable, false); // production ProxyChannel has no `has` trap
  assert.equal(
    hasMountedHierarchy({
      projectCatalogService: callable,
      workspaceHierarchyService: callable,
    } as unknown as IServiceAccessor),
    true,
  );
  assert.equal(
    hasMountedHierarchy({ projectCatalogService: callable } as unknown as IServiceAccessor),
    false,
  );
});
