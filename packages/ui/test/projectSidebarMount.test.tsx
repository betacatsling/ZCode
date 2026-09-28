import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { ProjectSidebarMountView } from "../src/project-sidebar/ProjectSidebarMountView.js";

const fallback = <div data-legacy-workspace="legacy">Legacy workspace</div>;
const tree = <div data-project-tree="tree">Project tree</div>;

test("ProjectSidebar mount keeps legacy DOM while loading and adds management when Catalog is empty", () => {
  const loading = renderToStaticMarkup(
    <ProjectSidebarMountView loadState={{ status: "loading" }} fallback={fallback}>
      {tree}
    </ProjectSidebarMountView>,
  );
  const empty = renderToStaticMarkup(
    <ProjectSidebarMountView
      loadState={{ status: "ready", model: { snapshot: { projects: [] } } }}
      fallback={fallback}
    >
      <div data-project-management="true">Project management entry</div>
    </ProjectSidebarMountView>,
  );
  assert.match(loading, /data-legacy-workspace/);
  assert.doesNotMatch(loading, /data-project-tree/);
  assert.match(empty, /data-legacy-workspace/);
  assert.match(empty, /data-project-management/);
  assert.doesNotMatch(empty, /data-project-tree/);
});

test("ProjectSidebar mount replaces the legacy region only after a non-empty catalog is ready", () => {
  const ready = renderToStaticMarkup(
    <ProjectSidebarMountView
      loadState={{
        status: "ready",
        model: { snapshot: { projects: [{ projectId: "project-one" }] } },
      }}
      fallback={fallback}
    >
      {tree}
    </ProjectSidebarMountView>,
  );
  assert.match(ready, /data-project-tree/);
  assert.doesNotMatch(ready, /data-legacy-workspace/);
});

test("unavailable Host capability reports fallback and retains actual legacy DOM", () => {
  const unavailable = renderToStaticMarkup(
    <ProjectSidebarMountView
      loadState={{ status: "unavailable", reason: "unsupported-host-directory" }}
      fallback={fallback}
      unavailableReason={
        <p data-project-sidebar-unavailable="true">Showing existing workspaces and tasks.</p>
      }
    >
      {tree}
    </ProjectSidebarMountView>,
  );

  assert.match(unavailable, /data-project-sidebar-unavailable/);
  assert.match(unavailable, /data-legacy-workspace/);
  assert.doesNotMatch(unavailable, /data-project-tree/);
});
