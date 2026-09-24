import {
  ServiceCollection,
  IAgentHostService,
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  IModelSelectionService,
  IProviderSettingsService,
  IFileService,
  IMediaPreviewService,
  ISettingService,
  IOnboardingRecordService,
  ICredentialService,
  IBroadcastService,
  ICuaPermissionService,
  IConversationShareService,
  IBotsService,
  IFileWatcherService,
  IOAuthService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IClientConfigService,
  IClientScenesService,
  IOffPeakTaskService,
  ISkillsService,
  ISkillSyncService,
  IMcpSyncService,
  IPluginSyncService,
  IPluginsService,
  IPluginManagementService,
  ISubagentsService,
  ICommandsService,
  IHooksService,
  IMemoryService,
  ISettingsSyncService,
  IFeedbackService,
  IPromptAttachmentTransferService,
  IGitService,
  IGitCheckpointService,
  ISystemService,
  ITerminalService,
  prepareTargetAttachment,
} from "@zcode/services";
import type { TargetHostRpcAttachment } from "./targetHostRpc.js";
import { connectTargetHostRpc } from "./targetHostRpc.js";

export interface CoreAttachmentLocation {
  endpoint: string;
  installationId: string;
  version: string;
  generation: number;
}

/** No local service factory: every registered mutable session/worktree route belongs to Core. */
export async function mountLocalCore(location: CoreAttachmentLocation): Promise<{
  services: ServiceCollection;
  attachment: TargetHostRpcAttachment;
}> {
  const ticket = await prepareTargetAttachment(
    location.endpoint,
    location.installationId,
    undefined,
    location.version,
  );
  const attachment = await connectTargetHostRpc(ticket);
  try {
    const host = attachment.services.agentHostService;
    if (!host) throw new Error("Core Host authority unavailable");
    const availability = await host.getAvailability();
    if (!availability.target.available || availability.target.id !== location.installationId) {
      throw new Error("Core Host availability identity mismatch");
    }
    const remote = attachment.services;
    const services = new ServiceCollection();
    services
      .register(IAgentHostService, remote.agentHostService)
      .register(IProjectCatalogRpcService, remote.projectCatalogService)
      .register(IWorkspaceHierarchyService, remote.workspaceHierarchyService)
      .register(IZCodeAgentService, remote.zcodeAgentService)
      .register(IZCodeSessionService, remote.zcodeSessionService)
      .register(IZCodeTaskService, remote.zcodeTaskService)
      .register(IModelSelectionService, remote.modelSelectionService)
      .register(IProviderSettingsService, remote.providerSettingsService)
      .register(IFileService, remote.fileService)
      .register(IMediaPreviewService, remote.mediaPreviewService)
      .register(ISettingService, remote.settingService)
      .register(IOnboardingRecordService, remote.onboardingRecordService)
      .register(ICredentialService, remote.credentialService)
      .register(IBroadcastService, remote.broadcastService)
      .register(ICuaPermissionService, remote.cuaPermissionService)
      .register(IConversationShareService, remote.conversationShareService)
      .register(IBotsService, remote.botsService)
      .register(IFileWatcherService, remote.fileWatcherService)
      .register(IOAuthService, remote.oauthService)
      .register(IUsageStatsService, remote.usageStatsService)
      .register(ICodingPlanSubscriptionService, remote.codingPlanSubscriptionService)
      .register(IClientConfigService, remote.clientConfigService)
      .register(IClientScenesService, remote.clientScenesService)
      .register(IOffPeakTaskService, remote.offPeakTaskService)
      .register(ISkillsService, remote.skillsService)
      .register(ISkillSyncService, remote.skillSyncService)
      .register(IMcpSyncService, remote.mcpSyncService)
      .register(IPluginSyncService, remote.pluginSyncService)
      .register(IPluginsService, remote.pluginsService)
      .register(IPluginManagementService, remote.pluginManagementService)
      .register(ISubagentsService, remote.subagentsService)
      .register(ICommandsService, remote.commandsService)
      .register(IHooksService, remote.hooksService)
      .register(IMemoryService, remote.memoryService)
      .register(ISettingsSyncService, remote.settingsSyncService)
      .register(IFeedbackService, remote.feedbackService)
      .register(IPromptAttachmentTransferService, remote.promptAttachmentTransferService)
      .register(IGitService, remote.gitService)
      .register(IGitCheckpointService, remote.gitCheckpointService)
      .register(ISystemService, remote.systemService)
      .register(ITerminalService, remote.terminalService);
    return { services, attachment };
  } catch (error) {
    attachment.dispose();
    throw error;
  }
}
