/* eslint-disable max-lines -- Browser fixture composes the production sidebar, legacy history, and real service-port test doubles in one DOM. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Theme } from "../../src/useTheme.js";
import { useZCodeIntl, ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectSidebarMount } from "../../src/project-sidebar/ProjectSidebarMount.js";
import type {
  AgentHostConversationAttachment,
  AgentHostConversationSelection,
} from "../../src/v4/agentHostConversationOwner.js";
import { useProjectSidebarViewStore } from "../../src/store/projectSidebarViewStore.js";
import { registerBaseWorkspaceServices } from "../../src/store/remoteWorkspaceSessionStore.js";
import { projectSidebarLegacyTaskExclusionKey } from "../../src/project-sidebar/legacyTaskExclusions.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import type { WorktreeWorkspaceRecord } from "@zcode/services/worktree";
import type { FixtureCounters } from "./projectSidebarBrowserFixtureData.js";
import type { IPlatformService } from "@zcode/shared";
import { createFixtureState, currentCatalog } from "./projectSidebarBrowserFixtureData.js";
import { installHierarchyFixture } from "./projectSidebarBrowserHierarchy.js";
import { createServicePorts } from "./projectSidebarBrowserFixturePorts.js";
import { ProjectSidebarExternalConversationBody } from "./ProjectSidebarExternalConversationBody.js";
import "../../src/styles.css";

const state = createFixtureState();
const stateV1 = createServicePorts(state, "v1");
let activeServices = stateV1;

declare global {
  interface Window {
    __projectSidebarFixture: {
      counters(): FixtureCounters;
      getViewState(): {
        activeProjectId: string | null;
        activeWorkspaceKey: string | null;
        activeSessionKey: string | null;
      };
      getSelectedTasks(): string[];
      getSelectedExternalSessionId(): string | null;
      getExternalSelectionEvents(): string[];
      getNativeServiceCalls(): Array<{ service: string; method: string; sessionId?: string }>;
      getCatalogProjectIds(): string[];
      getCatalogWorkspaceReferenceCount(projectId: string): number;
      getCatalogProjects(): Array<{
        id: string;
        workspaceIds: string[];
        defaultWorkspaceId?: string;
      }>;
      getWorktreeRecords(): WorktreeWorkspaceRecord[];
      expandSessionRows(): void;
      failNextCreateWithoutCandidate(): void;
      holdNextCatalogRead(): void;
      releaseHeldCatalogReads(): void;
      installHierarchyFixture(workspacePath?: string): void;
      emitBackgroundEvent(): void;
      prepareFocusedInput(): void;
      checkFocusedInput(): {
        sameNode: boolean;
        focused: boolean;
        value: string;
        selectionStart: number | null;
        selectionEnd: number | null;
      };
      prepareFocusedChatInput(): void;
      checkFocusedChatInput(): {
        sameNode: boolean;
        focused: boolean;
        text: string;
        anchorOffset: number | null;
        focusOffset: number | null;
      };
      failNextExternalSubscribe(): Promise<void>;
      setOldHostUnavailable(value: boolean): void;
      setTargetOffline(value: boolean): void;
      switchScope(path: string): void;
      switchHostGeneration(): void;
    };
  }
}

function ProjectSidebarBrowserFixture() {
  const [workspacePath, setWorkspacePath] = useState("/fixture/repo");
  const [services, setServices] = useState(activeServices);
  const [selectedExternalSession, setSelectedExternalSession] =
    useState<AgentHostConversationSelection | null>(null);
  const selectionGeneration = useRef(0);
  const selectedExternalSessionRef = useRef<AgentHostConversationSelection | null>(null);
  selectedExternalSessionRef.current = selectedExternalSession;
  const [, setFixtureRevision] = useState(0);
  const fixturePlatform = useMemo(
    () =>
      new Proxy(Object.create(null) as Record<string, unknown>, {
        get(_target, property) {
          const method = String(property);
          if (method.startsWith("on")) return () => () => {};
          return async () => undefined;
        },
      }) as unknown as IPlatformService,
    [],
  );
  const bumpFixtureRevision = () => setFixtureRevision((revision) => revision + 1);

  useEffect(() => {
    registerBaseWorkspaceServices(services);
  }, [services]);

  useEffect(() => {
    const handleFocus = (event: FocusEvent) => {
      const input = event.target;
      if (
        input instanceof HTMLInputElement &&
        input.matches("[data-project-sidebar-add-form] input")
      ) {
        (window as Window & { __focusedProjectInput?: HTMLInputElement }).__focusedProjectInput =
          input;
      }
    };
    document.addEventListener("focusin", handleFocus);
    return () => document.removeEventListener("focusin", handleFocus);
  }, []);

  const api = useMemo(() => {
    window.__projectSidebarFixture = {
      counters: () => structuredClone(state.counters),
      getViewState: () => {
        const view = useProjectSidebarViewStore.getState();
        return {
          expandedProjectIds: [...view.expandedProjectIds],
          expandedWorkspaceKeys: [...view.expandedWorkspaceKeys],
          hiddenWorkspaceKeys: [...view.hiddenWorkspaceKeys],
          activeProjectId: view.activeProjectId,
          activeWorkspaceKey: view.activeWorkspaceKey,
          activeSessionKey: view.activeSessionKey,
        };
      },
      getSelectedTasks: () => [...state.selectedTasks],
      getSelectedExternalSessionId: () =>
        selectedExternalSessionRef.current?.sessionSpec.hostSessionId ?? null,
      getExternalSelectionEvents: () => [...state.externalSelectionEvents],
      getNativeServiceCalls: () => structuredClone(state.nativeServiceCalls),
      getCatalogProjectIds: () => currentCatalog(state).projects.map((project) => project.id),
      getCatalogWorkspaceReferenceCount: (projectId) =>
        currentCatalog(state).projects.find((project) => project.id === projectId)
          ?.workspaceReferences.length ?? 0,
      getCatalogProjects: () => structuredClone(currentCatalog(state).projects),
      getWorktreeRecords: () => structuredClone(state.worktrees.workspaces),
      expandSessionRows: () => {
        const view = useProjectSidebarViewStore.getState();
        const projectId = state.firstProjectId;
        if (projectId && !view.expandedProjectIds.includes(projectId))
          view.toggleProject(projectId);
        const linkedKey = JSON.stringify(["fixture-target", "one-linked"]);
        if (!view.expandedWorkspaceKeys.includes(linkedKey)) {
          view.toggleWorkspace("fixture-target", "one-linked");
        }
      },
      failNextCreateWithoutCandidate: () => {
        state.failNextCreateCandidateMissing = true;
      },
      holdNextCatalogRead: () => {
        state.holdNextCatalogRead = true;
      },
      releaseHeldCatalogReads: () => {
        for (const release of state.heldCatalogReads.splice(0)) release();
      },
      installHierarchyFixture: (externalWorkspacePath?: string) => {
        installHierarchyFixture(state, externalWorkspacePath);
        bumpFixtureRevision();
      },
      emitBackgroundEvent: () => {
        const summary = state.summaries.find((item) => item.spec.hostSessionId === "pi-review");
        if (!summary) return;
        summary.title = "Background summary updated";
        summary.updatedAt += 1_000;
        for (const listener of state.eventListeners) {
          listener({
            spec: summary.spec,
            event: {
              kind: "session.status",
              hostSessionId: summary.spec.hostSessionId,
              runtimeEpoch: "fixture-epoch",
              sequence: summary.updatedAt,
              eventId: `fixture-${summary.updatedAt}`,
              at: summary.updatedAt,
              state: "running",
            },
          });
        }
      },
      prepareFocusedInput: () => {
        const input = document.querySelector<HTMLInputElement>(
          "[data-project-sidebar-add-form] input[aria-label='Project name']",
        );
        input?.focus();
        input?.setSelectionRange(2, Math.min(6, input.value.length));
      },
      checkFocusedInput: () => {
        const input = (window as Window & { __focusedProjectInput?: HTMLInputElement })
          .__focusedProjectInput;
        return {
          sameNode: Boolean(
            input &&
            input.isConnected &&
            input ===
              document.querySelector(
                "[data-project-sidebar-add-form] input[aria-label='Project name']",
              ),
          ),
          focused: Boolean(input && document.activeElement === input),
          value: input?.value ?? "",
          selectionStart: input?.selectionStart ?? null,
          selectionEnd: input?.selectionEnd ?? null,
        };
      },
      prepareFocusedChatInput: () => {
        const editor = document.querySelector<HTMLElement>("[data-testid='v4-composer-input']");
        if (!editor) return;
        (window as Window & { __focusedChatEditor?: HTMLElement }).__focusedChatEditor = editor;
        editor.focus();
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode();
        if (!textNode) return;
        const selection = window.getSelection();
        if (!selection) return;
        const range = document.createRange();
        range.setStart(textNode, Math.min(3, textNode.textContent?.length ?? 0));
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      },
      checkFocusedChatInput: () => {
        const editor = document.querySelector<HTMLElement>("[data-testid='v4-composer-input']");
        const selection = window.getSelection();
        const previous = (window as Window & { __focusedChatEditor?: HTMLElement })
          .__focusedChatEditor;
        return {
          sameNode: Boolean(previous && previous.isConnected && previous === editor),
          focused: Boolean(editor && document.activeElement === editor),
          text: editor?.textContent ?? "",
          anchorOffset: selection?.anchorOffset ?? null,
          focusOffset: selection?.focusOffset ?? null,
        };
      },
      failNextExternalSubscribe: async () => {
        await fetch("/__agent-host/test/fail-next-subscribe", { method: "POST" });
      },
      setOldHostUnavailable: (value: boolean) => {
        state.unavailableDirectory = value;
      },
      setTargetOffline: (value: boolean) => {
        state.targetOffline = value;
      },
      switchScope: (path: string) => {
        state.currentScope = path;
        setWorkspacePath(path);
      },
      switchHostGeneration: () => {
        activeServices = createServicePorts(state, "v2");
        setServices(activeServices);
      },
    };
    return window.__projectSidebarFixture;
  }, []);

  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>
        <PlatformProvider platform={fixturePlatform}>
          <ServiceProvider services={services}>
            <TabStoreProvider>
              <div className="flex h-full w-full flex-col bg-background text-foreground">
                <div className="flex flex-wrap items-center gap-2 border-b border-border p-2 text-ui-sm">
                  <span data-fixture-type="isolated-service-port">
                    Isolated service-port fixture
                  </span>
                  <button
                    type="button"
                    data-fixture-action="install-hierarchy"
                    onClick={() => api.installHierarchyFixture()}
                  >
                    Load hierarchy fixture
                  </button>
                  <button
                    type="button"
                    data-fixture-action="fail-next-project-create"
                    onClick={() => state.failNextProjectCreates++}
                  >
                    Fail next Project create
                  </button>
                  <button
                    type="button"
                    data-fixture-action="fail-next-reference"
                    onClick={() => state.failNextWorkspaceRefWrites++}
                  >
                    Fail next Catalog ref write
                  </button>
                  <button
                    type="button"
                    data-fixture-action="fail-create-without-candidate"
                    onClick={api.failNextCreateWithoutCandidate}
                  >
                    Omit next created-worktree candidate
                  </button>
                  <button
                    type="button"
                    data-fixture-action="switch-scope"
                    onClick={() => api.switchScope("/fixture/other")}
                  >
                    Switch scope
                  </button>
                  <button
                    type="button"
                    data-fixture-action="switch-host"
                    onClick={() => api.switchHostGeneration()}
                  >
                    Switch Host generation
                  </button>
                  <button
                    type="button"
                    data-fixture-action="toggle-offline"
                    onClick={() => api.setTargetOffline(!state.targetOffline)}
                  >
                    Toggle target offline
                  </button>
                  <button
                    type="button"
                    data-fixture-action="toggle-old-host"
                    onClick={() => api.setOldHostUnavailable(!state.unavailableDirectory)}
                  >
                    Toggle old Host directory
                  </button>
                  <FixtureLocaleToggle />
                  <output data-fixture-scope="true">{workspacePath}</output>
                </div>
                <div className="min-h-0 flex flex-1 flex-row">
                  <aside
                    style={{ width: "clamp(280px, 34vw, 384px)" }}
                    className="min-h-0 min-w-0 shrink-0 overflow-y-auto p-2"
                  >
                    <ProjectSidebarMount
                      workspacePath={workspacePath}
                      theme={"light" as Theme}
                      fallback={(excludedTaskKeys) => (
                        <div data-legacy-workspace="true" className="space-y-2 p-2">
                          <span>Legacy workspace and tasks</span>
                          <input aria-label="Legacy task search" placeholder="Legacy task search" />
                          {state.tasks
                            .filter(
                              (task) =>
                                !excludedTaskKeys.has(projectSidebarLegacyTaskExclusionKey(task)),
                            )
                            .map((task) => (
                              <button
                                key={task.taskId}
                                type="button"
                                data-legacy-task={task.taskId}
                                onClick={() =>
                                  state.selectedTasks.push(`${task.workspacePath}:${task.taskId}`)
                                }
                              >
                                {task.title}
                              </button>
                            ))}
                        </div>
                      )}
                      onSelectTask={(path, sessionId) => {
                        setSelectedExternalSession(null);
                        state.selectedTasks.push(`${path}:${sessionId}`);
                        bumpFixtureRevision();
                      }}
                      onSelectExternalSession={(selection: AgentHostConversationAttachment) => {
                        state.externalSelectionEvents.push(selection.sessionSpec.hostSessionId);
                        setSelectedExternalSession({
                          ...selection,
                          selectionGeneration: ++selectionGeneration.current,
                        });
                      }}
                      onStartDraft={() => bumpFixtureRevision()}
                    />
                  </aside>
                  <main
                    data-testid="external-conversation-body-region"
                    className="relative flex h-full min-h-0 min-w-0 w-0 flex-1 flex-col overflow-hidden border-l border-border"
                  >
                    {selectedExternalSession ? (
                      <ProjectSidebarExternalConversationBody selection={selectedExternalSession} />
                    ) : (
                      <div data-external-conversation-unselected="true" className="p-4 text-ui-sm">
                        Select a Project session to open its conversation.
                      </div>
                    )}
                  </main>
                </div>
              </div>
            </TabStoreProvider>
          </ServiceProvider>
        </PlatformProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

function FixtureLocaleToggle() {
  const { locale, setLocale } = useZCodeIntl();
  return (
    <button
      type="button"
      data-fixture-action="toggle-locale"
      onClick={() => setLocale(locale === "en-US" ? "zh-CN" : "en-US")}
    >
      Toggle locale
    </button>
  );
}

document.body.dataset.fixtureEntryExecuted = "true";
createRoot(document.getElementById("root")!).render(<ProjectSidebarBrowserFixture />);
