# accepted-controls early interface

Public API: `IAgentHostService` and `WorkspaceAdmissionPort` remain unchanged. `AgentHostTargetService.dispatch(spec, command)` routes persisted mounted cancel/deny through the existing `SessionHost.dispatch` after exact target/spec ownership; send/resume/allow continue through existing `WorkspaceAdmissionPort`. No new Target/Catalog port is required. Feature-off lazy service uses history-only reads and existing in-memory owner for control; no cold worker startup.

Base SHA: 12d86b6. Early spec/interface commit SHA: d711d7b335cabcb1cb3ac834940fb39c6519bed2.
