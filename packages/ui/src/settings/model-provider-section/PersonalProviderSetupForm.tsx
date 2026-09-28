import { useState } from "react";
import type { ProviderApiType } from "@zcode/provider";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ApiKeyInput } from "./ApiKeyInput.js";
import { ProviderApiFormatSelect } from "./ProviderApiFormatSelect.js";
import {
  buildPersonalProviderInitialConfig,
  resolvePersonalProviderSetupName,
  validatePersonalProviderSetup,
  type PersonalProviderSetupDraft,
  type PersonalProviderSetupIssue,
} from "./personalProviderSetup.js";

const ISSUE_MESSAGE_IDS: Record<PersonalProviderSetupIssue, string> = {
  "endpoint-required": "settings.modelProvider.personalSetup.endpointRequired",
  "endpoint-invalid": "settings.modelProvider.personalSetup.endpointInvalid",
  "api-key-required": "settings.modelProvider.personalSetup.apiKeyRequired",
  "model-required": "settings.modelProvider.personalSetup.modelRequired",
};

export function PersonalProviderSetupForm({
  creating,
  onBack,
  onCreate,
}: {
  creating: boolean;
  onBack: () => void;
  onCreate: (input: {
    providerName: string;
    modelId: string;
    initialConfig: ReturnType<typeof buildPersonalProviderInitialConfig>;
  }) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiType, setApiType] = useState<ProviderApiType>("openai-chat-completions");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [modelId, setModelId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const draft: PersonalProviderSetupDraft = { name, baseUrl, apiType, apiKey, modelId };
    const issue = validatePersonalProviderSetup(draft);
    if (issue) {
      setError(intl.formatMessage({ id: ISSUE_MESSAGE_IDS[issue] }));
      return;
    }
    setError(null);
    try {
      await onCreate({
        providerName: resolvePersonalProviderSetupName(draft),
        modelId: modelId.trim(),
        initialConfig: buildPersonalProviderInitialConfig(draft),
      });
    } catch (createError) {
      logger.error("[PersonalProviderSetup] 保存自定义供应商失败", createError);
      setError(
        intl.formatMessage(
          { id: "settings.modelProvider.personalSetup.saveError" },
          {
            error: createError instanceof Error ? createError.message : String(createError),
          },
        ),
      );
    }
  };

  return (
    <section className="space-y-4" data-testid="personal-provider-setup">
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "settings.modelProvider.templatePickerBack" })}
          disabled={creating}
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <div className="min-w-0">
          <h2 className="text-ui-lg font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.modelProvider.addProviderTitle" })}
          </h2>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.modelProvider.addProviderDescription" })}
          </p>
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.name" })}
        </span>
        <Input
          size="lg"
          value={name}
          disabled={creating}
          placeholder={intl.formatMessage({ id: "settings.modelProvider.namePlaceholder" })}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}
        </span>
        <Input
          size="lg"
          value={baseUrl}
          disabled={creating}
          placeholder={intl.formatMessage({ id: "settings.modelProvider.baseUrlPlaceholder" })}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.apiFormat" })}
        </span>
        <ProviderApiFormatSelect value={apiType} onChange={setApiType} />
      </label>
      <label className="block space-y-1">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
        </span>
        <ApiKeyInput
          value={apiKey}
          visible={apiKeyVisible}
          onChange={setApiKey}
          onBlur={() => undefined}
          onToggleVisibility={() => setApiKeyVisible((current) => !current)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.modelProvider.modelId" })}
        </span>
        <Input
          size="lg"
          value={modelId}
          disabled={creating}
          placeholder="gpt-4.1"
          onChange={(event) => setModelId(event.target.value)}
        />
      </label>
      {error ? (
        <p role="alert" className="text-ui-base text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" disabled={creating} onClick={() => void submit()}>
          {intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
        </Button>
        <Button type="button" variant="ghost" disabled={creating} onClick={onBack}>
          {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
        </Button>
      </div>
    </section>
  );
}
