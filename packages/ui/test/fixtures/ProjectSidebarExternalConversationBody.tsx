import { V4AgentHostConversationProvider } from "../../src/v4/V4AgentHostConversationProvider.js";
import type { AgentHostConversationSelection } from "../../src/v4/agentHostConversationOwner.js";
import { SessionPane } from "../../src/v4/SessionPane.js";

export function ProjectSidebarExternalConversationBody({
  selection,
}: {
  selection: AgentHostConversationSelection;
}) {
  return (
    <div
      data-external-conversation-body="true"
      data-owner-session-id={selection.sessionSpec.hostSessionId}
      className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      <V4AgentHostConversationProvider selection={selection}>
        <SessionPane
          paneId="workspace-main"
          sessionId={selection.sessionSpec.hostSessionId}
          workspacePath={selection.ownerRecord.workspacePath}
          workspaceIdentity={
            selection.remoteSessionId
              ? selection.sessionSpec.execution.workspaceIdentity
              : undefined
          }
          remoteSessionId={selection.remoteSessionId ?? undefined}
          focused
          telemetryVisible={false}
        />
      </V4AgentHostConversationProvider>
    </div>
  );
}
