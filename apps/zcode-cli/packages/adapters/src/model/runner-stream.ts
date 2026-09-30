import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelProtocolError,
  ModelRetryReason,
  ModelTransportKind as ModelTransportKindValue,
} from "@zcode/contracts";
import { classifyModelFailure, type ClassifiedModelFailure } from "./failure-classifier.js";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import { getResponseHeaders, unwrapRetryError } from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import {
  createLinkedAbortController,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.js";
import {
  createStreamDiagnostics,
  isZeroOutputModelCompletion,
  isSuspiciousStreamDiagnostics,
  logStreamDiagnostics,
  logStreamFailureDiagnostics,
} from "./runner-diagnostics.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { createStreamTextOptions } from "./runner-options.js";
import {
  isDevelopmentModelIOEnv,
  recordStreamTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import { retryAttemptLoopContinues, retryBudgetMaxAttempts } from "./retry-budget.js";
import type { EnvRecord } from "./model-execution.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
  publishModelTelemetryMilestone,
} from "./runner-status.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkStreamTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { resolveModelForAttempt, RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import {
  modelFailureStatusFields,
  providerRequestIdFromHeaders,
  readModelFailureErrorPhase,
} from "./runner-telemetry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";
import {
  compactStreamFailureContext,
  resolveStreamFailureDecision,
} from "./runner-stream-failure-policy.js";
import {
  applyStreamEventsToRetryBoundary,
  compactDirectToolCallCommitEvent,
  observeVisibleStreamEvent,
} from "./runner-stream-boundary.js";
import {
  closeStreamIteratorBestEffort,
  publishRetryScheduledStatus,
  resolveStreamResponseHeaders,
  statusPublishOptions,
} from "./runner-stream-lifecycle.js";
import { handleStreamChunk } from "./runner-stream-chunk.js";

export async function* runStreamText(input: {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
  modelIoFullRetentionEnabled: boolean;
}): AsyncGenerator<ModelStreamEvent> {
  // 重试预算档位：只放宽瞬态失败的放弃条件；
  // `emittedRetryBoundaryEvent` 之后不重试的规则不变。状态事件 maxAttempts 以 0 表示无上限。
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  const recordModelIO = shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  let emptyCompletionRetryCount = 0;

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted),
    );
    attempt += 1
  ) {
    const retryBudgetAttempt = attempt - Number(signatureRepairAttempted);
    const startedAt = Date.now();
    // SSE idle timeout 后的重试如果仍固定首请求窗口，容易被同一段 provider 静默窗口反复打断；
    // core recovery 和 adapter 内部 retry 都统一按重试次数每次增加 30s。
    const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
    });
    let emittedEvent = false;
    let emittedRetryBoundaryEvent = false;
    let emittedError = false;
    let retryScheduledFromStreamChunk = false;
    let offPeakQueueHoldFromStreamChunk = false;
    const pendingRetrySafeEvents: ModelStreamEvent[] = [];
    const diagnostics = createStreamDiagnostics();
    const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    const attemptRequest = {
      ...input.request,
      abortSignal: attemptAbortController.signal,
      messages: requestMessages,
    };
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(Number(signatureRepairAttempted)),
      },
      attempt,
    );
    const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    let streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
    let streamReachedNaturalEnd = false;
    let attemptFailed = false;
    let awaitIteratorClose = false;
    let terminalStatusPublished = false;
    // 提升到 try 外,使 catch 分支也能拿到 options/result 记录失败 model-io。
    let options: ReturnType<typeof createStreamTextOptions> | undefined;
    let result: AiSdkStreamTextResult | undefined;
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;
    let resolved = input.resolved;
    let timeToFirstProviderEventMs: number | undefined;
    let timeToFirstContentMs: number | undefined;
    let timeToFirstTextMs: number | undefined;
    let streamMaxIdleMs = 0;
    let streamStallCount = 0;
    let streamOutputCommitted = false;
    const repairThinkingSignatureRejection = (error: unknown): boolean => {
      if (signatureRepairAttempted || resolved.providerKind !== "anthropic") {
        return false;
      }
      const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
        requestMessages,
        error,
      );
      if (!repairedMessages) return false;

      // 签名只对生成它的 thinking block 有效。流尚未提交输出时，只替换
      // 本次请求副本，并给一次不占普通 retry 预算且拥有新 requestId 的物理请求机会；
      // 不能把清理结果写回 canonical history。
      signatureRepairAttempted = true;
      requestMessages = repairedMessages;
      input.logger?.warn("Retrying model stream after thinking signature rejection", {
        attempt,
        event: "model.reasoning_signature_repair.retry",
        maxAttempts: input.retry.maxAttempts + 1,
        nextAttempt: attempt + 1,
        requestId: statusContext.requestId,
        status: "waiting",
      });
      return true;
    };
    const publishVisibleMilestones = async (observation: {
      contentMs?: number;
      textMs?: number;
    }): Promise<void> => {
      if (timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
        timeToFirstContentMs = observation.contentMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.contentMs,
            timestamp: new Date(startedAt + observation.contentMs).toISOString(),
            type: "model_first_content",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
      if (timeToFirstTextMs === undefined && observation.textMs !== undefined) {
        timeToFirstTextMs = observation.textMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.textMs,
            timestamp: new Date(startedAt + observation.textMs).toISOString(),
            type: "model_first_text",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
    };

    // 进程级准入：每次尝试发出前等槽位，
    // 票据在本次尝试结束时归还（成功 / 失败 / 抛出 / 消费者放弃流都经 finally；退避 sleep 之前先归还）。
    // 等待中被取消 → 与 sleep 被取消同一条路：记 connect 阶段的 cancelled 失败，抛出。
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: { providerId: String(resolved.providerId), modelId: String(resolved.modelId) },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      attemptAbortController.cleanup();
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: Date.now() - startedAt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount,
          requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          streamOutputCommitted,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, statusContext, attempt, {
        errorPhase: "connect",
      });
    }

    try {
      resolved = await resolveModelForAttempt({
        attempt,
        request: attemptRequest,
        resolveModel: input.resolveModel,
      });
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: resolved.providerKind,
        sessionId: statusContext.sessionId,
      });
      options = createStreamTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        logger: input.logger,
        request: attemptRequest,
        resolved,
        statusContext,
      });
      requestHeaders = sanitizeModelNetworkHeaders(options.headers);
      requestHeaderCount = Object.keys(requestHeaders).length;
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          requestHeaderCount,
          requestHeaders,
          timestamp: new Date(startedAt).toISOString(),
          type: "model_request_started",
        },
        statusPublishOptions(input, admission),
      );
      const streamResult = input.runtime.streamText(options);
      result = streamResult;
      streamIterator = streamResult.fullStream[Symbol.asyncIterator]();

      while (true) {
        const next = await readNextWithStreamIdleTimeout(streamIterator, {
          abortController: attemptAbortController.controller,
          onTimeout: async (error) => {
            streamStallCount += 1;
            streamMaxIdleMs = Math.max(streamMaxIdleMs, error.idleMs);
            await publishModelStatus(
              {
                ...statusContext,
                attempt,
                idleMs: error.idleMs,
                message: error.message,
                requestHeaderCount,
                requestHeaders,
                timeoutMs: error.timeoutMs,
                timestamp: new Date().toISOString(),
                type: "model_stream_stalled",
              },
              statusPublishOptions(input, admission),
            );
          },
          timeoutMs: streamIdleTimeoutMs,
        });
        if (next.done) {
          streamReachedNaturalEnd = true;
          break;
        }
        if (timeToFirstProviderEventMs === undefined) {
          timeToFirstProviderEventMs = Date.now() - startedAt;
          await publishModelTelemetryMilestone(
            {
              ...statusContext,
              attempt,
              elapsedMs: timeToFirstProviderEventMs,
              timestamp: new Date(startedAt + timeToFirstProviderEventMs).toISOString(),
              type: "model_first_provider_event",
            },
            { logger: input.logger, statusSink: input.statusSink },
          );
        }

        let event: Awaited<ReturnType<typeof handleStreamChunk>>;
        try {
          event = await handleStreamChunk({
            admission,
            attempt,
            chunk: next.value,
            diagnostics,
            emittedRetryBoundaryEvent,
            input,
            pendingRetrySafeEvents,
            requestHeaderCount,
            requestHeaders,
            repairThinkingSignatureRejection,
            retryBudgetAttempt,
            startedAt,
            statusContext,
            toolCallAssembler,
          });
        } catch (error) {
          const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
          if (directToolCommit) {
            // 完整 direct tool-call 已是 provider 事件；name/input 校验即使抛错，
            // 也不能让 adapter 当作首事件前失败再次 SSE 重放。
            emittedRetryBoundaryEvent = true;
            for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
              emittedEvent = true;
              yield pendingEvent;
            }
            // 无 raw message-block provenance 的 provider 可能直接给完整 tool-call。
            // 先把 inferred block stop 交给隐藏 collector，再传播校验错误，避免 HTTP 重放。
            emittedEvent = true;
            yield directToolCommit;
          }
          throw error;
        }
        const shouldHoldEmptyCompletionEvents =
          !event.emittedError &&
          event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
          input.request.preserveProviderStreamBoundaries !== true &&
          isZeroOutputModelCompletion({
            finishReason: diagnostics.finishReason,
            reasoningLength: diagnostics.reasoningDeltaChars,
            textLength: diagnostics.textDeltaChars,
            toolCallCount: diagnostics.toolCallCount,
            usage: diagnostics.usage,
          }) &&
          canRetryEmptyCompletion({
            abortSignal: input.request.abortSignal,
            attempt,
            maxAttempts: input.retry.maxAttempts,
            retryCount: emptyCompletionRetryCount,
          });
        if (shouldHoldEmptyCompletionEvents) {
          // finish 会把已缓存的 start 一并刷给 core；先暂存到自然 EOF，确认这是
          // generic empty 后再重试，避免第一次 attempt 的 finish/start 泄漏到 UI。
          event.visibleEvents.length = 0;
        }
        emittedError = emittedError || event.emittedError;
        emittedEvent = emittedEvent || event.emittedEvent;
        emittedRetryBoundaryEvent = emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

        if (event.retryScheduled) {
          // SSE error chunk 的 retry 是正常控制流，不会进入 catch；
          // 若不显式标记失败，finally 会跳过旧 attempt 的 iterator/tee 清理。
          // 下一次物理请求必须等待本轮 abort 与有界清理后才能启动。
          attemptFailed = true;
          awaitIteratorClose = true;
          retryScheduledFromStreamChunk = true;
          offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
          break;
        }
        if (event.terminalError) {
          throw event.terminalError;
        }
        if (event.visibleEvents.length > 0) {
          for (const visibleEvent of event.visibleEvents) {
            const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
            await publishVisibleMilestones(observation);
            streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
            yield visibleEvent;
          }
        }
      }

      if (retryScheduledFromStreamChunk) {
        if (offPeakQueueHoldFromStreamChunk) {
          // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试。
          attempt -= 1;
        }
        continue;
      }

      const flushedEvents = applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent,
        events: toolCallAssembler.flush(),
        pendingRetrySafeEvents,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
      });
      emittedEvent = emittedEvent || flushedEvents.emittedEvent;
      emittedRetryBoundaryEvent =
        emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
      if (flushedEvents.visibleEvents.length > 0) {
        for (const visibleEvent of flushedEvents.visibleEvents) {
          const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
          await publishVisibleMilestones(observation);
          streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
          yield visibleEvent;
        }
      }

      for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
        emittedEvent = true;
        const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - startedAt);
        await publishVisibleMilestones(observation);
        streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
        yield pendingEvent;
      }

      if (!emittedError) {
        // 自然 EOF 后合成的业务错误会通过 TerminalStreamChunkError 直接离开外层 catch；
        // compact 上下文在普通主链路为空，因此必须在合成现场显式保留 stream 阶段。
        // 先识别 provider business error，再考虑 generic empty；否则额度等
        // HTTP 200 空流会被误判成可重试的暂时性空响应。
        const hiddenProviderBusinessError = detectProviderBusinessFinishError({
          providerId: String(statusContext.providerId),
          providerKind: statusContext.providerKind,
          source:
            diagnostics.lastFinishChunk ??
            ({
              type: "finish",
              finishReason: diagnostics.finishReason,
              rawFinishReason: diagnostics.rawFinishReason,
            } satisfies Record<string, unknown>),
        });
        if (hiddenProviderBusinessError) {
          const failure = classifyModelFailure(
            hiddenProviderBusinessError,
            input.request.abortSignal,
          );
          throw new TerminalStreamChunkError(
            toAdapterError(hiddenProviderBusinessError, failure, statusContext, attempt, {
              ...compactStreamFailureContext(
                input.request.preserveProviderStreamBoundaries,
                "response_body",
              ),
              errorPhase: "stream",
            }),
          );
        }

        if (isSuspiciousStreamDiagnostics(diagnostics)) {
          // 403 JSON 等业务错误有时不会让 AI SDK 抛出 error chunk，流会以空 completion 结束；
          // 若不在 adapter 层终止，core 会误报 “Model returned no text...”。
          const streamEndedWithoutOutputError = detectProviderBusinessFinishError({
            providerId: String(statusContext.providerId),
            providerKind: statusContext.providerKind,
            source: diagnostics.lastErrorChunk ?? diagnostics.lastFinishChunk,
          });
          if (streamEndedWithoutOutputError) {
            const failure = classifyModelFailure(
              streamEndedWithoutOutputError,
              input.request.abortSignal,
            );
            throw new TerminalStreamChunkError(
              toAdapterError(streamEndedWithoutOutputError, failure, statusContext, attempt, {
                ...compactStreamFailureContext(
                  input.request.preserveProviderStreamBoundaries,
                  "response_body",
                ),
                errorPhase: "stream",
              }),
            );
          }

          if (
            input.request.preserveProviderStreamBoundaries !== true &&
            isZeroOutputModelCompletion({
              finishReason: diagnostics.finishReason,
              reasoningLength: diagnostics.reasoningDeltaChars,
              textLength: diagnostics.textDeltaChars,
              toolCallCount: diagnostics.toolCallCount,
              usage: diagnostics.usage,
            }) &&
            canRetryEmptyCompletion({
              abortSignal: input.request.abortSignal,
              attempt,
              maxAttempts: input.retry.maxAttempts,
              retryCount: emptyCompletionRetryCount,
            })
          ) {
            const responseHeaders = await resolveStreamResponseHeaders(streamResult);
            const completedAt = Date.now();
            // finish 会把 retry-safe 前奏刷成可见事件；空 completion 需在
            // flush 前进入一次 adapter retry，避免 core 把第一次 attempt 当成已完成。
            logStreamDiagnostics({
              attempt,
              diagnostics,
              durationMs: completedAt - startedAt,
              emittedError,
              emittedEvent,
              logger: input.logger,
              outboundHeaders: resolved.headers,
              statusContext,
            });
            emptyCompletionRetryCount += 1;
            await scheduleEmptyCompletionRetry({
              abortSignal: input.request.abortSignal,
              attempt,
              completedAt,
              errorPhase: "stream",
              logger: input.logger,
              requestHeaders,
              requestStatusSink: input.request.statusSink,
              responseHeaders,
              retry: input.retry,
              retryBudgetAttempt,
              startedAt,
              statusContext,
              statusSink: input.statusSink,
              streamOutputCommitted: false,
            });
            continue;
          }
        }
      }

      logStreamDiagnostics({
        attempt,
        diagnostics,
        durationMs: Date.now() - startedAt,
        emittedError,
        emittedEvent,
        logger: input.logger,
        outboundHeaders: resolved.headers,
        statusContext,
      });
      if (!emittedError) {
        const completedAt = Date.now();
        const responseHeaders = await resolveStreamResponseHeaders(streamResult);
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: completedAt - startedAt,
            requestHeaderCount,
            requestHeaders,
            responseHeaderCount: Object.keys(responseHeaders).length,
            responseHeaders,
            providerRequestId: providerRequestIdFromHeaders(responseHeaders),
            finishReason: diagnostics.finishReason,
            usage: diagnostics.usage,
            timeToFirstProviderEventMs,
            timeToFirstContentMs,
            timeToFirstTextMs,
            streamMaxIdleMs: streamMaxIdleMs || undefined,
            streamStallCount,
            streamOutputCommitted,
            timestamp: new Date(completedAt).toISOString(),
            type: "model_request_completed",
          },
          statusPublishOptions(input, admission),
        );
        terminalStatusPublished = true;
      }
      if (recordModelIO && options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          result: streamResult,
          startedAt,
        });
      }
      return;
    } catch (error) {
      attemptFailed = true;
      if (recordModelIO && options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          error,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          result,
          startedAt,
        });
      }
      if (error instanceof TerminalStreamChunkError) {
        awaitIteratorClose = true;
        throw error.adapterError;
      }
      if (
        error instanceof ModelProtocolError &&
        error.code === ModelErrorCode.ModelRequestAuthMissing
      ) {
        // stream 在 attempt try 内解析请求鉴权，过去会把网络前的类型化
        // 鉴权缺失错误重新归一化为通用请求失败；generate 则直接保留原始协议错误。
        throw error;
      }

      const completedAt = Date.now();
      const retryWithRepairedHistory =
        !emittedRetryBoundaryEvent && repairThinkingSignatureRejection(error);
      if (retryWithRepairedHistory) {
        statusContext = {
          ...statusContext,
          maxAttempts: statusMaxAttempts(1),
        };
      }
      const classified = classifyModelFailure(error, input.request.abortSignal);
      if (error instanceof RuntimeHeadersRefreshError) {
        classified.message = error.message;
        classified.retryable = false;
      }
      // off-peak 特判（仅 idle plan provider）：排队 429 豁免预算无限探测；3102 标记落败触发续跑。
      const offPeak = resolveOffPeakFailureDecision({
        offPeak: resolved.accountAccess?.mode === "off-peak",
        failure: classified,
        error: unwrapRetryError(error),
      });
      const failure: ClassifiedModelFailure =
        offPeak?.kind === "ticketExpired"
          ? {
              ...classified,
              retryable: false,
              message: offPeakTicketExpiredMessage(classified.message),
            }
          : offPeak?.kind === "queued"
            ? {
                ...classified,
                retryable: true,
                retryReason: ModelRetryReason.OffpeakQueued,
              }
            : classified;
      const errorPhase =
        readModelFailureErrorPhase(error) ?? (streamIterator === undefined ? "prepare" : "stream");
      awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
      const responseHeaders = sanitizeModelNetworkHeaders(
        getResponseHeaders(unwrapRetryError(error)),
      );
      const failureDecision = resolveStreamFailureDecision({
        attempt: retryBudgetAttempt,
        emittedRetryBoundaryEvent,
        error,
        failure,
        maxAttempts: input.retry.maxAttempts,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
        responseHeaders,
        retryBudget,
        streamIteratorCreated: streamIterator !== undefined,
        streamErrorChunkObserved: Boolean(
          diagnostics.lastErrorChunk || diagnostics.lastFinishChunk,
        ),
      });
      // off-peak 排队 429 豁免预算：不消耗 maxAttempts，SSE 可见输出边界仍适用。
      if (offPeak?.kind === "queued" && !emittedRetryBoundaryEvent) {
        failureDecision.canRetry = true;
      }
      if (retryWithRepairedHistory) {
        failureDecision.canRetry = true;
      }

      logStreamFailureDiagnostics({
        attempt,
        canRetry: failureDecision.canRetry,
        diagnostics,
        durationMs: completedAt - startedAt,
        emittedError,
        emittedEvent,
        emittedRetryBoundaryEvent,
        error,
        failure,
        logger: input.logger,
        statusContext,
      });
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: completedAt - startedAt,
          message: failure.message,
          reason: failure.reason,
          requestHeaderCount,
          requestHeaders,
          responseHeaderCount: Object.keys(responseHeaders).length,
          responseHeaders,
          retryable: failureDecision.canRetry,
          statusCode: failure.statusCode,
          streamOutputCommitted,
          ...modelFailureStatusFields(error, failure, errorPhase),
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input, admission),
          failureError: unwrapRetryError(error),
        },
      );
      terminalStatusPublished = true;

      if (retryWithRepairedHistory) {
        await publishRetryScheduledStatus(
          input,
          statusContext,
          attempt,
          0,
          {
            ...failure,
            retryReason: ModelRetryReason.ReasoningSignatureRepair,
          },
          requestHeaders,
          responseHeaders,
          admission,
        );
        continue;
      }

      if (!failureDecision.canRetry) {
        logRetryDelayDecision({
          attempt,
          canRetry: failureDecision.canRetry,
          failure,
          logger: input.logger,
          responseHeaders,
          statusContext,
        });
        throw toAdapterError(error, failure, statusContext, attempt, {
          ...failureDecision.context,
          errorPhase,
        });
      }

      const delayMs =
        offPeak?.kind === "queued"
          ? offPeak.delayMs
          : calculateRetryDelay(input.retry, retryBudgetAttempt, failure.retryAfterMs);
      logRetryDelayDecision({
        attempt,
        canRetry: failureDecision.canRetry,
        delayMs,
        failure,
        logger: input.logger,
        responseHeaders,
        statusContext,
      });

      await publishRetryScheduledStatus(
        input,
        statusContext,
        attempt,
        delayMs,
        failure,
        requestHeaders,
        responseHeaders,
        admission,
      );
      // 退避期间不持票：槽位让给别人，重试再准入。
      admission.release();
      try {
        await sleep(delayMs, input.request.abortSignal);
      } catch (sleepError) {
        const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: Date.now() - startedAt,
            message: sleepFailure.message,
            reason: sleepFailure.reason,
            requestHeaderCount,
            requestHeaders,
            retryable: false,
            statusCode: sleepFailure.statusCode,
            streamOutputCommitted,
            ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
            timestamp: new Date().toISOString(),
            type: "model_request_failed",
          },
          {
            // 退避期间票据已归还：这次取消不属于任何一次尝试，不转投票据。
            ...statusPublishOptions(input),
            failureError: unwrapRetryError(sleepError),
          },
        );
        terminalStatusPublished = true;
        throw toAdapterError(sleepError, sleepFailure, statusContext, attempt, {
          errorPhase: "connect",
        });
      }
      if (offPeak?.kind === "queued") {
        // 排队等待不消耗重试预算：回退计数让 for 自增后原地重试，无限探测。
        attempt -= 1;
      }
    } finally {
      if (
        !streamReachedNaturalEnd &&
        (attemptFailed || input.request.preserveProviderStreamBoundaries === true)
      ) {
        // 普通 stream 的 429 retry 失败若不进入本清理分支，
        // AI SDK fullStream tee 会持有旧 provider 请求，连续重试会让后续物理请求卡在发送前。
        // 失败 attempt 必须无条件中止并释放；普通 consumer 主动提前结束仍保持原语义。
        if (!attemptAbortController.signal.aborted) {
          attemptAbortController.controller.abort(
            new Error("Model stream attempt ended before natural EOF."),
          );
        }
        if (!attemptFailed && !terminalStatusPublished && !emittedError) {
          // consumer 侧的校验异常只会触发 AsyncIteratorClose，不会回到上面的 catch；
          // 将已启动的物理请求收口为 cancelled，避免 fallback 前遗留悬空 started 状态。
          const completedAt = Date.now();
          await publishModelStatus(
            {
              ...statusContext,
              attempt,
              durationMs: completedAt - startedAt,
              message: "Model stream consumer closed before natural EOF.",
              reason: ModelFailureReasonValue.Cancelled,
              requestHeaderCount,
              requestHeaders,
              retryable: false,
              errorCode: "model_request_cancelled",
              errorPhase: "stream",
              exceptionType: "AbortError",
              streamOutputCommitted,
              timestamp: new Date(completedAt).toISOString(),
              type: "model_request_failed",
            },
            statusPublishOptions(input, admission),
          );
        }
        if (attemptFailed && awaitIteratorClose) {
          await closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
            result,
          });
        } else {
          void closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
          });
        }
      } else if (attemptAbortController.signal.aborted) {
        // 普通 main 保留既有生命周期：只有 caller/idle 已经 abort 时才 best-effort 关闭 iterator。
        void closeStreamIteratorBestEffort(streamIterator, {
          attempt,
          logger: input.logger,
        });
      }
      attemptAbortController.cleanup();
      // 兜底归还（成功 / 抛出 / 消费者提前 return 都到这里）；正常失败路径已在 sleep 前归还，幂等。
      admission.release();
    }
  }
}
