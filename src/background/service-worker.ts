import {
  DEFAULT_SETTINGS,
  DEFAULT_TELEMETRY,
  STORAGE_KEYS,
} from '../shared/constants';
import {
  buildQuestionStateHash,
  extractUuid,
  isKahootHostname,
  isWaygroundHostname,
} from '../shared/normalize';
import {
  loadSettings,
  loadTelemetry,
  updateTelemetry,
} from '../shared/storage';
import type {
  AnswerResolution,
  BatchItemResolution,
  BatchQuestionItem,
  BatchQuestionPayload,
  ClipboardExtractedPayload,
  ContentPushMessage,
  EngineSettings,
  QuestionKind,
  QuestionPayload,
  RuntimeBatchResolveResponse,
  RuntimeCacheResponse,
  RuntimeClickResponse,
  RuntimeRequestMessage,
  RuntimeResolveResponse,
  RuntimeScanResponse,
  RuntimeStatusResponse,
} from '../shared/types';
import {
  raceBatchChoiceInference,
  raceParallelInference,
  runSurgicalArbiterVerification,
  warmupProviderConnections,
} from './ai-racer';
import {
  resolveFromClipboardPayload,
  resolveViaSystemClipboard,
} from './clipboard-solver';
import {
  clearTier1Cache,
  getLearnedQuestionCount,
  ingestKahootRestPayload,
  isQuizUuidAlreadyCached,
  lookupLearnedCache,
  lookupLearnedFillBlank,
  lookupTier1Cache,
  prefetchAndCacheQuiz,
  recordLearnedAnswer,
} from './quiz-cache';
import {
  SUPPORTED_TAB_URL_PATTERNS,
  clearUserCanceledCooldown,
  detachAllDebuggerTabs,
  detachDebuggerFromTab,
  executeTrustedClickInTab,
  executeTrustedTextFillInTab,
  isKahootActiveGameplayUrl,
  isKahootLobbyOrEndUrl,
  preattachDebuggerToKahootPlayerTabs,
  preattachDebuggerToTab,
  registerDebuggerLifecycleListeners,
} from './trusted-clicker';
import { resolveViaVisionCapture } from './vision-solver';

const HOST_BROADCAST_TTL_MS = 25_000;
let latestHostBroadcastResolution: AnswerResolution | null = null;
let hotSettingsCache: EngineSettings | null = null;

async function getFastSettings(): Promise<EngineSettings> {
  if (hotSettingsCache) {
    return hotSettingsCache;
  }
  hotSettingsCache = await loadSettings();
  return hotSettingsCache;
}

async function sendContentPushSafe(
  tabId: number,
  message: ContentPushMessage,
  frameId?: number
): Promise<void> {
  try {
    if (typeof frameId === 'number') {
      await chrome.tabs.sendMessage(tabId, message, { frameId });
    } else {
      await chrome.tabs.sendMessage(tabId, message);
    }
  } catch {
    return;
  }
}

registerDebuggerLifecycleListeners((canceledTabId) => {
  void sendContentPushSafe(canceledTabId, {
    type: 'CLIPBOARD_STATUS_TOAST',
    message:
      '⚡ Bạn vừa đóng thanh Debugging! Giữ nguyên thanh đó ở trên cùng để Auto-Click chuột thật hoạt động.',
    isError: true,
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEYS.SETTINGS]?.newValue) {
    const next = changes[STORAGE_KEYS.SETTINGS].newValue as EngineSettings;
    hotSettingsCache = next;
    if (!next.enabled || next.triggerMode === 'highlight_only') {
      void detachAllDebuggerTabs();
    } else {
      clearUserCanceledCooldown();
      void preattachDebuggerToKahootPlayerTabs();
    }
  }
});

async function openOrNavigateLivePinJoinTab(pin: string): Promise<boolean> {
  const joinUrl = 'https://kahoot.it/?pin=' + encodeURIComponent(pin);
  try {
    const existingJoinTabs = await chrome.tabs.query({
      url: [
        'https://kahoot.it/',
        'https://kahoot.it/?*',
        'https://kahoot.it/join*',
      ],
    });
    const reusableTab = existingJoinTabs.find(
      (item) => typeof item.id === 'number'
    );
    if (reusableTab && typeof reusableTab.id === 'number') {
      await chrome.tabs.update(reusableTab.id, { url: joinUrl, active: true });
      if (typeof reusableTab.windowId === 'number') {
        await chrome.windows.update(reusableTab.windowId, { focused: true });
      }
      return true;
    }
    await chrome.tabs.create({ url: joinUrl, active: true });
    return true;
  } catch {
    return false;
  }
}

function attachTriggerSettings(
  resolution: AnswerResolution,
  settings: EngineSettings,
  multiSelect: boolean,
  forceHighlightOnly = false
): AnswerResolution {
  return {
    ...resolution,
    multiSelect,
    triggerMode: forceHighlightOnly ? 'highlight_only' : settings.triggerMode,
    highlightStyle: settings.highlightStyle,
    targetScore: settings.targetScore,
    minDelayMs: settings.minDelayMs,
    maxDelayMs: settings.maxDelayMs,
  };
}

function getFreshHostBroadcastResolution(): AnswerResolution | null {
  if (!latestHostBroadcastResolution) {
    return null;
  }
  if (
    Date.now() - latestHostBroadcastResolution.timestamp >
    HOST_BROADCAST_TTL_MS
  ) {
    latestHostBroadcastResolution = null;
    return null;
  }
  return latestHostBroadcastResolution;
}

async function setBadgeFeedback(text: string, color: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
  } catch {
    return;
  }
}

function isKahootPlayableUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'kahoot.it' ||
      host === 'play.kahoot.it' ||
      isWaygroundHostname(host)
    );
  } catch {
    return false;
  }
}

function isHttpWebUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  return url.startsWith('https://') || url.startsWith('http://');
}

async function findTargetKahootTab(
  preferredTab?: chrome.tabs.Tab
): Promise<chrome.tabs.Tab | undefined> {
  if (
    preferredTab &&
    typeof preferredTab.id === 'number' &&
    isHttpWebUrl(preferredTab.url)
  ) {
    return preferredTab;
  }

  const [focusedTab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (
    focusedTab &&
    typeof focusedTab.id === 'number' &&
    isHttpWebUrl(focusedTab.url)
  ) {
    return focusedTab;
  }

  const quizTabs = await chrome.tabs.query({
    url: SUPPORTED_TAB_URL_PATTERNS,
  });
  const activeQuizTab = quizTabs.find(
    (item) => item.active && typeof item.id === 'number'
  );
  if (activeQuizTab) {
    return activeQuizTab;
  }

  return quizTabs.find((item) => typeof item.id === 'number') ?? focusedTab;
}

async function triggerUniversalScanOnTab(
  preferredTabId?: number
): Promise<RuntimeScanResponse> {
  try {
    const settings = await getFastSettings();
    if (!settings.enabled) {
      return {
        ok: false,
        detectedCount: 0,
        solvedCount: 0,
        error: 'Engine is currently paused. Enable Active toggle first.',
      };
    }

    let targetTab: chrome.tabs.Tab | undefined;
    if (typeof preferredTabId === 'number') {
      try {
        targetTab = await chrome.tabs.get(preferredTabId);
      } catch {
        targetTab = undefined;
      }
    }
    if (!targetTab) {
      targetTab = await findTargetKahootTab(undefined);
    }

    if (
      !targetTab ||
      typeof targetTab.id !== 'number' ||
      !isHttpWebUrl(targetTab.url)
    ) {
      return {
        ok: false,
        detectedCount: 0,
        solvedCount: 0,
        error: 'Open an HTTP/HTTPS quiz or LMS tab before scanning.',
      };
    }

    if (isKahootPlayableUrl(targetTab.url)) {
      await ensureContentScriptsOnOpenKahootTabs();
      return {
        ok: true,
        detectedCount: 1,
        solvedCount: 1,
      };
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id, allFrames: true },
        files: ['content/universal-lms.js'],
        world: 'ISOLATED',
      });
    } catch {
      void 0;
    }

    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: targetTab.id, allFrames: true },
      world: 'ISOLATED',
      func: async () => {
        const win = window as Window & {
          __kheUniversalTriggerScan?: (
            force: boolean
          ) => Promise<{ detectedCount: number; solvedCount: number }>;
        };
        if (typeof win.__kheUniversalTriggerScan === 'function') {
          return await win.__kheUniversalTriggerScan(true);
        }
        return { detectedCount: 0, solvedCount: 0 };
      },
    });

    let detectedCount = 0;
    let solvedCount = 0;
    for (const frame of frameResults) {
      if (frame?.result) {
        detectedCount += frame.result.detectedCount ?? 0;
        solvedCount += frame.result.solvedCount ?? 0;
      }
    }

    if (detectedCount > 0) {
      void setBadgeFeedback(String(solvedCount), '#0D9488');
    }

    return {
      ok: true,
      detectedCount,
      solvedCount,
    };
  } catch (err) {
    return {
      ok: false,
      detectedCount: 0,
      solvedCount: 0,
      error: err instanceof Error ? err.message : 'Page scan failed.',
    };
  }
}

async function ensureContentScriptsOnOpenKahootTabs(): Promise<void> {
  try {
    const settings = await getFastSettings();
    const openTabs = await chrome.tabs.query({
      url: SUPPORTED_TAB_URL_PATTERNS,
    });

    for (const tab of openTabs) {
      if (typeof tab.id !== 'number') {
        continue;
      }
      let alive = false;
      try {
        const pingReply = (await chrome.tabs.sendMessage(tab.id, {
          type: 'PING_CONTENT_ENGINE',
        } satisfies ContentPushMessage)) as { ok?: boolean } | undefined;
        alive = Boolean(pingReply?.ok);
      } catch {
        alive = false;
      }

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, allFrames: true },
          files: ['content/injector.js'],
          world: 'MAIN',
        });
        if (!alive) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true },
            files: ['content/content.js'],
            world: 'ISOLATED',
          });
        }
      } catch {
        void 0;
      }

      if (isKahootLobbyOrEndUrl(tab.url)) {
        await detachDebuggerFromTab(tab.id);
      } else if (
        settings.enabled &&
        settings.triggerMode !== 'highlight_only' &&
        isKahootActiveGameplayUrl(tab.url)
      ) {
        await preattachDebuggerToTab(tab.id);
      }
    }
  } catch {
    return;
  }
}

async function broadcastResolutionToPlayerTabs(
  resolution: AnswerResolution,
  excludeTabId?: number
): Promise<void> {
  try {
    const settings = await getFastSettings();
    const enriched = attachTriggerSettings(
      resolution,
      settings,
      Boolean(resolution.multiSelect)
    );
    const playerTabs = await chrome.tabs.query({
      url: ['https://kahoot.it/*', 'https://play.kahoot.it/*'],
    });
    for (const tab of playerTabs) {
      if (typeof tab.id !== 'number' || tab.id === excludeTabId) {
        continue;
      }
      if (
        settings.enabled &&
        settings.triggerMode === 'instant_auto_click' &&
        !enriched.multiSelect &&
        enriched.questionKind !== 'fill_blank' &&
        tab.url?.startsWith('https://kahoot.it/')
      ) {
        void executeTrustedClickInTab(tab.id, enriched.indices, false, false);
      }
      await sendContentPushSafe(tab.id, {
        type: 'APPLY_RESOLVED_ANSWER',
        resolution: enriched,
      });
    }
  } catch {
    return;
  }
}

async function handleBatchQuestionResolution(
  payload: BatchQuestionPayload,
  senderTabId: number | undefined,
  senderFrameId: number | undefined
): Promise<RuntimeBatchResolveResponse> {
  const settings = await getFastSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'KahootHybridEngine is currently paused.',
    };
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return { ok: true, resolutions: [] };
  }

  const startedAt = performance.now();
  const requireVerified = Boolean(payload.forceRefresh);
  const resolvedMap = new Map<string, BatchItemResolution>();
  const uncachedItems: BatchQuestionItem[] = [];

  for (const item of payload.items) {
    const tier1 = await lookupTier1Cache(item.questionText, item.options);
    if (tier1 && tier1.length > 0) {
      resolvedMap.set(item.stateHash, {
        stateHash: item.stateHash,
        questionIndex: item.questionIndex,
        indices: tier1,
        tier: 'tier1_cache',
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      continue;
    }

    const learned = await lookupLearnedCache(
      item.questionText,
      item.options,
      requireVerified
    );
    if (learned && learned.length > 0) {
      resolvedMap.set(item.stateHash, {
        stateHash: item.stateHash,
        questionIndex: item.questionIndex,
        indices: learned,
        tier: 'tier1_learned',
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      });
      continue;
    }

    uncachedItems.push(item);
  }

  if (uncachedItems.length === 0) {
    return {
      ok: true,
      resolutions: payload.items
        .map((it) => resolvedMap.get(it.stateHash))
        .filter((x): x is BatchItemResolution => Boolean(x)),
    };
  }

  try {
    const batchOutcomes = await raceBatchChoiceInference(
      uncachedItems,
      payload.pageContext,
      settings
    );

    const disputedOutcomes = batchOutcomes.filter(
      (o) => o.resolution.disputed || o.resolution.indices.length === 0
    );

    for (const outcome of batchOutcomes) {
      if (outcome.resolution.indices.length > 0) {
        resolvedMap.set(outcome.item.stateHash, outcome.resolution);
        if (
          !outcome.resolution.disputed &&
          outcome.resolution.tier === 'tier3_consensus'
        ) {
          void recordLearnedAnswer(
            outcome.item.questionText,
            outcome.item.options,
            outcome.resolution.indices,
            false
          );
        }
      }
    }

    const orderedFast = payload.items
      .map((it) => resolvedMap.get(it.stateHash))
      .filter((x): x is BatchItemResolution => Boolean(x));

    if (orderedFast.length > 0) {
      const sample = orderedFast[orderedFast.length - 1];
      void updateTelemetry({
        lastTier: sample.tier,
        lastLatencyMs: sample.latencyMs,
        lastIndices: sample.indices,
        lastQuestionHash: sample.stateHash,
        lastError: null,
      });
    }

    if (disputedOutcomes.length > 0 && typeof senderTabId === 'number') {
      void (async () => {
        for (const disputed of disputedOutcomes) {
          const verified = await runSurgicalArbiterVerification(
            {
              questionText: disputed.item.questionText,
              options: disputed.item.options,
              multiSelect: disputed.item.multiSelect,
              optionCount: disputed.item.optionCount,
            },
            disputed.competingCandidates,
            payload.pageContext,
            settings
          );
          if (verified && verified.indices.length > 0) {
            if (verified.tier === 'tier3_consensus') {
              void recordLearnedAnswer(
                disputed.item.questionText,
                disputed.item.options,
                verified.indices,
                false
              );
            }
            const overrideRes = attachTriggerSettings(
              {
                stateHash: disputed.item.stateHash,
                questionIndex: disputed.item.questionIndex,
                indices: verified.indices,
                questionKind: 'choice',
                tier: verified.tier,
                latencyMs: verified.latencyMs,
                timestamp: Date.now(),
                voteSummary: verified.voteSummary,
                disputed: false,
              },
              settings,
              disputed.item.multiSelect,
              !settings.lmsAutoClickEnabled
            );
            await sendContentPushSafe(
              senderTabId,
              {
                type: 'APPLY_ARBITER_RESOLUTION',
                stateHash: disputed.item.stateHash,
                resolution: overrideRes,
              },
              senderFrameId
            );
          }
        }
      })();
    }

    return {
      ok: true,
      resolutions: orderedFast,
    };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : 'Batch AI resolution failed';
    void updateTelemetry({ lastError: errorMsg });
    return {
      ok: false,
      error: errorMsg,
    };
  }
}

async function handleQuestionResolution(
  payload: QuestionPayload,
  senderTabId: number | undefined,
  senderWindowId: number | undefined,
  senderTabUrl?: string,
  senderFrameId?: number
): Promise<RuntimeResolveResponse> {
  const settings = await getFastSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'KahootHybridEngine is currently paused.',
    };
  }

  const isExternalSite =
    payload.platform === 'universal' || !isKahootPlayableUrl(senderTabUrl);
  const effectivePayload: QuestionPayload = isExternalSite
    ? { ...payload, deepAccuracy: true }
    : payload;
  const requireVerifiedCache = Boolean(effectivePayload.forceRefresh);

  const finalizeResolution = (base: AnswerResolution): RuntimeResolveResponse => {
    const enriched = attachTriggerSettings(
      base,
      settings,
      payload.multiSelect,
      isExternalSite && !settings.lmsAutoClickEnabled
    );
    if (
      !isExternalSite &&
      settings.triggerMode === 'instant_auto_click' &&
      typeof senderTabId === 'number'
    ) {
      if (enriched.questionKind === 'fill_blank' && enriched.fillText) {
        void executeTrustedTextFillInTab(senderTabId, enriched.fillText, true);
      } else if (!payload.multiSelect && enriched.indices.length > 0) {
        void executeTrustedClickInTab(
          senderTabId,
          enriched.indices,
          false,
          false
        );
      }
    }
    return { ok: true, resolution: enriched };
  };

  const startedAt = performance.now();

  if (effectivePayload.questionKind === 'fill_blank') {
    const learnedFill = await lookupLearnedFillBlank(
      effectivePayload.questionText,
      requireVerifiedCache
    );
    if (learnedFill) {
      const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
      const resolution: AnswerResolution = {
        stateHash: payload.stateHash,
        questionIndex: payload.questionIndex,
        indices: [],
        fillText: learnedFill,
        questionKind: 'fill_blank',
        tier: 'tier1_learned',
        latencyMs,
        timestamp: Date.now(),
      };

      void Promise.all([
        updateTelemetry({
          lastTier: 'tier1_learned',
          lastLatencyMs: latencyMs,
          lastIndices: [],
          lastQuestionHash: payload.stateHash,
          lastError: null,
        }),
        setBadgeFeedback('TXT', '#059669'),
      ]);

      return finalizeResolution(resolution);
    }

    const canRunVision =
      !isExternalSite &&
      (settings.groqApiKey.length > 0 || settings.geminiApiKey.length > 0);

    if (payload.hasQuestionImage && canRunVision) {
      try {
        const visionFill = await resolveViaVisionCapture(
          senderWindowId,
          4,
          false,
          settings,
          {
            questionKind: 'fill_blank',
            blankLengthHint: payload.blankLengthHint,
            contextQuestionText: payload.questionText,
          }
        );
        if (!visionFill.hostOnlyBlank && visionFill.fillText) {
          void recordLearnedAnswer(
            payload.questionText,
            [],
            [],
            false,
            visionFill.fillText
          );
          const resolution: AnswerResolution = {
            stateHash: payload.stateHash,
            questionIndex: payload.questionIndex,
            indices: [],
            fillText: visionFill.fillText,
            questionKind: 'fill_blank',
            tier: 'tier4_vision',
            latencyMs: visionFill.latencyMs,
            timestamp: Date.now(),
          };
          void Promise.all([
            updateTelemetry({
              lastTier: 'tier4_vision',
              lastLatencyMs: visionFill.latencyMs,
              lastIndices: [],
              lastQuestionHash: payload.stateHash,
              lastError: null,
            }),
            setBadgeFeedback('TXT', '#9333EA'),
          ]);
          return finalizeResolution(resolution);
        }
      } catch {
        void 0;
      }
    }

    if (effectivePayload.questionText.trim().length > 0) {
      try {
        const raceWinner = await raceParallelInference(
          effectivePayload,
          settings
        );
        const answerText = raceWinner.fillText ?? '';
        if (!answerText) {
          return { ok: false, error: 'AI returned an empty fill-blank answer.' };
        }

        if (!isExternalSite || raceWinner.tier === 'tier3_consensus') {
          void recordLearnedAnswer(
            effectivePayload.questionText,
            [],
            [],
            false,
            answerText
          );
        }

        const resolution: AnswerResolution = {
          stateHash: payload.stateHash,
          questionIndex: payload.questionIndex,
          indices: [],
          fillText: answerText,
          questionKind: 'fill_blank',
          tier: raceWinner.tier,
          latencyMs: raceWinner.latencyMs,
          timestamp: Date.now(),
          voteSummary: raceWinner.voteSummary,
        };

        const badgeColor =
          raceWinner.tier === 'tier3_consensus' ? '#0284C7' : '#2563EB';
        void Promise.all([
          updateTelemetry({
            lastTier: raceWinner.tier,
            lastLatencyMs: raceWinner.latencyMs,
            lastIndices: [],
            lastQuestionHash: payload.stateHash,
            lastError: null,
          }),
          setBadgeFeedback('TXT', badgeColor),
        ]);

        return finalizeResolution(resolution);
      } catch (err) {
        const errorMsg =
          err instanceof Error ? err.message : 'Fill-blank inference failed';
        void updateTelemetry({ lastError: errorMsg });
        return { ok: false, error: errorMsg };
      }
    }

    if (isExternalSite) {
      return {
        ok: false,
        error: 'Unable to extract fill-in-the-blank text on external page.',
      };
    }

    try {
      const visionFill = await resolveViaVisionCapture(
        senderWindowId,
        4,
        false,
        settings,
        {
          questionKind: 'fill_blank',
          blankLengthHint: payload.blankLengthHint,
        }
      );
      if (visionFill.hostOnlyBlank || !visionFill.fillText) {
        return {
          ok: false,
          hostOnlyBlank: Boolean(visionFill.hostOnlyBlank),
          error: 'Could not detect fill-in-the-blank question on screen.',
        };
      }
      const resolution: AnswerResolution = {
        stateHash: payload.stateHash,
        questionIndex: payload.questionIndex,
        indices: [],
        fillText: visionFill.fillText,
        questionKind: 'fill_blank',
        tier: 'tier4_vision',
        latencyMs: visionFill.latencyMs,
        timestamp: Date.now(),
      };
      void Promise.all([
        updateTelemetry({
          lastTier: 'tier4_vision',
          lastLatencyMs: visionFill.latencyMs,
          lastIndices: [],
          lastQuestionHash: payload.stateHash,
          lastError: null,
        }),
        setBadgeFeedback('TXT', '#9333EA'),
      ]);
      return finalizeResolution(resolution);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'Vision fill-blank failed';
      void updateTelemetry({ lastError: errorMsg });
      return { ok: false, error: errorMsg };
    }
  }

  if (
    settings.quizId &&
    extractUuid(settings.quizId) &&
    !isQuizUuidAlreadyCached(settings.quizId)
  ) {
    void prefetchAndCacheQuiz(settings.quizId, false);
  }

  const cachedIndices = await lookupTier1Cache(
    payload.questionText,
    payload.options
  );

  if (cachedIndices && cachedIndices.length > 0) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const resolution: AnswerResolution = {
      stateHash: payload.stateHash,
      questionIndex: payload.questionIndex,
      indices: cachedIndices,
      questionKind: 'choice',
      tier: 'tier1_cache',
      latencyMs,
      timestamp: Date.now(),
    };

    void Promise.all([
      updateTelemetry({
        lastTier: 'tier1_cache',
        lastLatencyMs: latencyMs,
        lastIndices: cachedIndices,
        lastQuestionHash: payload.stateHash,
        lastError: null,
      }),
      setBadgeFeedback(cachedIndices.join(','), '#16A34A'),
    ]);

    return finalizeResolution(resolution);
  }

  const learnedIndices = await lookupLearnedCache(
    effectivePayload.questionText,
    effectivePayload.options,
    requireVerifiedCache
  );

  if (learnedIndices && learnedIndices.length > 0) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const resolution: AnswerResolution = {
      stateHash: payload.stateHash,
      questionIndex: payload.questionIndex,
      indices: learnedIndices,
      questionKind: 'choice',
      tier: 'tier1_learned',
      latencyMs,
      timestamp: Date.now(),
    };

    void Promise.all([
      updateTelemetry({
        lastTier: 'tier1_learned',
        lastLatencyMs: latencyMs,
        lastIndices: learnedIndices,
        lastQuestionHash: payload.stateHash,
        lastError: null,
      }),
      setBadgeFeedback(learnedIndices.join(','), '#059669'),
    ]);

    return finalizeResolution(resolution);
  }

  const hasReadableQuestion = payload.questionText.trim().length > 0;
  const hasReadableOptions = payload.options.some(
    (opt) => opt.trim().length > 0
  );
  const canRunVision =
    settings.groqApiKey.length > 0 || settings.geminiApiKey.length > 0;

  if (
    payload.platform === 'wayground' &&
    payload.hasQuestionImage &&
    canRunVision
  ) {
    try {
      const visionResult = await resolveViaVisionCapture(
        senderWindowId,
        payload.optionCount,
        payload.multiSelect,
        settings,
        {
          questionKind: 'choice',
          contextQuestionText: payload.questionText,
          contextOptions: payload.options,
        }
      );
      if (!visionResult.hostOnlyBlank && visionResult.indices.length > 0) {
        if (hasReadableQuestion && hasReadableOptions) {
          void recordLearnedAnswer(
            payload.questionText,
            payload.options,
            visionResult.indices,
            false
          );
        }
        const resolution: AnswerResolution = {
          stateHash: payload.stateHash,
          questionIndex: payload.questionIndex,
          indices: visionResult.indices,
          questionKind: 'choice',
          tier: 'tier4_vision',
          latencyMs: visionResult.latencyMs,
          timestamp: Date.now(),
        };
        void Promise.all([
          updateTelemetry({
            lastTier: 'tier4_vision',
            lastLatencyMs: visionResult.latencyMs,
            lastIndices: visionResult.indices,
            lastQuestionHash: payload.stateHash,
            lastError: null,
          }),
          setBadgeFeedback(visionResult.indices.join(','), '#9333EA'),
        ]);
        return finalizeResolution(resolution);
      }
    } catch {
      void 0;
    }
  }

  if (hasReadableQuestion && hasReadableOptions) {
    try {
      const deferArbiter = isExternalSite && typeof senderTabId === 'number';
      const raceWinner = await raceParallelInference(
        effectivePayload,
        settings,
        { deferArbiter }
      );
      const resolution: AnswerResolution = {
        stateHash: payload.stateHash,
        questionIndex: payload.questionIndex,
        indices: raceWinner.indices,
        questionKind: 'choice',
        tier: raceWinner.tier,
        latencyMs: raceWinner.latencyMs,
        timestamp: Date.now(),
        voteSummary: raceWinner.voteSummary,
        disputed: Boolean(raceWinner.disputed),
      };

      if (
        !raceWinner.disputed &&
        (!isExternalSite || raceWinner.tier === 'tier3_consensus')
      ) {
        void recordLearnedAnswer(
          effectivePayload.questionText,
          effectivePayload.options,
          raceWinner.indices,
          false
        );
      }

      if (
        deferArbiter &&
        raceWinner.disputed &&
        typeof senderTabId === 'number'
      ) {
        const optionCount = Math.max(
          2,
          effectivePayload.optionCount || effectivePayload.options.length || 4
        );
        void (async () => {
          const verified = await runSurgicalArbiterVerification(
            {
              questionText: effectivePayload.questionText,
              options: effectivePayload.options,
              multiSelect: effectivePayload.multiSelect,
              optionCount,
              imageBase64: effectivePayload.imageBase64,
              imageMimeType: effectivePayload.imageMimeType,
            },
            raceWinner.competingIndices ?? [raceWinner.indices],
            effectivePayload.pageContext,
            settings
          );
          if (verified && verified.indices.length > 0) {
            if (verified.tier === 'tier3_consensus') {
              void recordLearnedAnswer(
                effectivePayload.questionText,
                effectivePayload.options,
                verified.indices,
                false
              );
            }
            const overrideRes = attachTriggerSettings(
              {
                stateHash: payload.stateHash,
                questionIndex: payload.questionIndex,
                indices: verified.indices,
                questionKind: 'choice',
                tier: verified.tier,
                latencyMs: verified.latencyMs,
                timestamp: Date.now(),
                voteSummary: verified.voteSummary,
                disputed: false,
              },
              settings,
              payload.multiSelect,
              !settings.lmsAutoClickEnabled
            );
            await sendContentPushSafe(
              senderTabId,
              {
                type: 'APPLY_ARBITER_RESOLUTION',
                stateHash: payload.stateHash,
                resolution: overrideRes,
              },
              senderFrameId
            );
          }
        })();
      }

      const badgeColor =
        raceWinner.tier === 'tier3_consensus' ? '#0284C7' : '#2563EB';

      void Promise.all([
        updateTelemetry({
          lastTier: raceWinner.tier,
          lastLatencyMs: raceWinner.latencyMs,
          lastIndices: raceWinner.indices,
          lastQuestionHash: payload.stateHash,
          lastError: null,
        }),
        setBadgeFeedback(raceWinner.indices.join(','), badgeColor),
      ]);

      return finalizeResolution(resolution);
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : 'Tier 3 inference failed';
      void updateTelemetry({ lastError: errorMsg });
      return { ok: false, error: errorMsg };
    }
  }

  if (isExternalSite) {
    return {
      ok: false,
      error: 'Unable to read question text or choices on external page.',
    };
  }

  try {
    const visionResult = await resolveViaVisionCapture(
      senderWindowId,
      payload.optionCount,
      payload.multiSelect,
      settings,
      {
        questionKind: 'choice',
        contextQuestionText: payload.questionText,
        contextOptions: payload.options,
      }
    );
    if (visionResult.hostOnlyBlank) {
      return {
        ok: false,
        hostOnlyBlank: true,
        error: 'Host-Only mode: question is hidden on student tab.',
      };
    }

    const resolution: AnswerResolution = {
      stateHash: payload.stateHash,
      questionIndex: payload.questionIndex,
      indices: visionResult.indices,
      questionKind: 'choice',
      tier: 'tier4_vision',
      latencyMs: visionResult.latencyMs,
      timestamp: Date.now(),
    };

    void Promise.all([
      updateTelemetry({
        lastTier: 'tier4_vision',
        lastLatencyMs: visionResult.latencyMs,
        lastIndices: visionResult.indices,
        lastQuestionHash: payload.stateHash,
        lastError: null,
      }),
      setBadgeFeedback(visionResult.indices.join(','), '#9333EA'),
    ]);

    return finalizeResolution(resolution);
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : 'Tier 4 Vision fallback failed';
    void updateTelemetry({ lastError: errorMsg });
    return { ok: false, error: errorMsg };
  }
}

async function handleExplicitVisionFallback(
  stateHash: string,
  questionIndex: number,
  optionCount: number,
  multiSelect: boolean,
  tabId: number | undefined,
  windowId: number | undefined,
  questionKind?: QuestionKind,
  blankLengthHint?: number,
  tabUrl?: string
): Promise<RuntimeResolveResponse> {
  const settings = await getFastSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'KahootHybridEngine is currently paused.',
    };
  }

  let resolvedTabUrl = tabUrl;
  if (!resolvedTabUrl && typeof tabId === 'number') {
    try {
      const t = await chrome.tabs.get(tabId);
      resolvedTabUrl = t.url;
    } catch {
      resolvedTabUrl = undefined;
    }
  }
  const isExternalHighlightOnly = !isKahootPlayableUrl(resolvedTabUrl);

  try {
    const visionResult = await resolveViaVisionCapture(
      windowId,
      optionCount,
      multiSelect,
      settings,
      {
        questionKind,
        blankLengthHint,
      }
    );
    if (visionResult.hostOnlyBlank) {
      return {
        ok: false,
        hostOnlyBlank: true,
        error:
          'Host-Only screen: use Win+Shift+S then Alt+Shift+V (or Ctrl+V).',
      };
    }

    const isFill = questionKind === 'fill_blank' && Boolean(visionResult.fillText);
    const resolution = attachTriggerSettings(
      {
        stateHash,
        questionIndex,
        indices: visionResult.indices,
        fillText: visionResult.fillText,
        questionKind: isFill ? 'fill_blank' : 'choice',
        tier: 'tier4_vision',
        latencyMs: visionResult.latencyMs,
        timestamp: Date.now(),
      },
      settings,
      multiSelect,
      isExternalHighlightOnly
    );

    if (
      !isExternalHighlightOnly &&
      settings.triggerMode === 'instant_auto_click' &&
      typeof tabId === 'number'
    ) {
      if (isFill && resolution.fillText) {
        void executeTrustedTextFillInTab(tabId, resolution.fillText, true);
      } else if (!multiSelect && resolution.indices.length > 0) {
        void executeTrustedClickInTab(tabId, resolution.indices, false, false);
      }
    }

    void Promise.all([
      updateTelemetry({
        lastTier: 'tier4_vision',
        lastLatencyMs: visionResult.latencyMs,
        lastIndices: visionResult.indices,
        lastQuestionHash: stateHash,
        lastError: null,
      }),
      setBadgeFeedback(
        isFill ? 'TXT' : visionResult.indices.join(','),
        '#9333EA'
      ),
    ]);

    return { ok: true, resolution };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : 'Vision capture failed';
    void updateTelemetry({ lastError: errorMsg });
    return { ok: false, error: errorMsg };
  }
}

async function handleClipboardVisionRequest(
  stateHash: string,
  questionIndex: number,
  optionCount: number,
  multiSelect: boolean,
  tabId: number | undefined,
  directPayload?: ClipboardExtractedPayload,
  questionKind?: QuestionKind,
  blankLengthHint?: number,
  tabUrl?: string
): Promise<RuntimeResolveResponse> {
  const settings = await getFastSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'KahootHybridEngine is currently paused.',
    };
  }

  let resolvedTabUrl = tabUrl;
  if (!resolvedTabUrl && typeof tabId === 'number') {
    try {
      const t = await chrome.tabs.get(tabId);
      resolvedTabUrl = t.url;
    } catch {
      resolvedTabUrl = undefined;
    }
  }
  const isExternalHighlightOnly = !isKahootPlayableUrl(resolvedTabUrl);

  try {
    const clipboardResult = directPayload
      ? await resolveFromClipboardPayload(
          directPayload,
          optionCount,
          multiSelect,
          settings,
          questionKind,
          blankLengthHint
        )
      : await resolveViaSystemClipboard(
          optionCount,
          multiSelect,
          settings,
          questionKind,
          blankLengthHint
        );

    const isFill =
      questionKind === 'fill_blank' && Boolean(clipboardResult.fillText);

    const resolution = attachTriggerSettings(
      {
        stateHash,
        questionIndex,
        indices: clipboardResult.indices,
        fillText: clipboardResult.fillText,
        questionKind: isFill ? 'fill_blank' : 'choice',
        tier: 'tier4_clipboard',
        latencyMs: clipboardResult.latencyMs,
        timestamp: Date.now(),
      },
      settings,
      multiSelect,
      isExternalHighlightOnly
    );

    if (
      !isExternalHighlightOnly &&
      settings.triggerMode === 'instant_auto_click' &&
      typeof tabId === 'number'
    ) {
      if (isFill && resolution.fillText) {
        void executeTrustedTextFillInTab(tabId, resolution.fillText, true);
      } else if (!multiSelect && resolution.indices.length > 0) {
        void executeTrustedClickInTab(tabId, resolution.indices, false, false);
      }
    }

    void Promise.all([
      updateTelemetry({
        lastTier: 'tier4_clipboard',
        lastLatencyMs: clipboardResult.latencyMs,
        lastIndices: clipboardResult.indices,
        lastQuestionHash: stateHash,
        lastError: null,
      }),
      setBadgeFeedback(
        isFill ? 'TXT' : clipboardResult.indices.join(','),
        '#EA580C'
      ),
    ]);

    return { ok: true, resolution };
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : 'Clipboard Vision failed';
    void updateTelemetry({ lastError: errorMsg });
    return { ok: false, error: errorMsg };
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS,
      [STORAGE_KEYS.TELEMETRY]: DEFAULT_TELEMETRY,
    });
  }
  await ensureContentScriptsOnOpenKahootTabs();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureContentScriptsOnOpenKahootTabs();
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (
      details.tabId < 0 ||
      (typeof details.initiator === 'string' &&
        details.initiator.startsWith('chrome-extension://'))
    ) {
      return undefined;
    }
    const detectedUuid = extractUuid(details.url);
    if (detectedUuid) {
      void prefetchAndCacheQuiz(detectedUuid, false);
    }
    return undefined;
  },
  {
    urls: [
      'https://kahoot.it/rest/kahoots/*',
      'https://play.kahoot.it/rest/kahoots/*',
      'https://create.kahoot.it/rest/kahoots/*',
    ],
  }
);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const candidateUrl = changeInfo.url ?? tab.url ?? '';
  if (!candidateUrl) {
    return;
  }

  if (isKahootLobbyOrEndUrl(candidateUrl)) {
    void detachDebuggerFromTab(tabId);
  }

  let isSupportedHost = false;
  let isLmsExamHost = false;
  try {
    const parsedUrl = new URL(candidateUrl);
    const host = parsedUrl.hostname.toLowerCase();
    const lowerHref = candidateUrl.toLowerCase();
    isSupportedHost = isKahootHostname(host) || isWaygroundHostname(host);
    isLmsExamHost =
      lowerHref.includes('/mod/quiz/') ||
      host.includes('lms.') ||
      host.startsWith('lms') ||
      host.includes('moodle') ||
      host.includes('elearning') ||
      host.includes('instructure.com');
  } catch {
    isSupportedHost = false;
  }

  const shouldWarmup =
    isLmsExamHost ||
    candidateUrl.includes('play.kahoot.it/v2/lobby') ||
    candidateUrl.includes('kahoot.it/instructions') ||
    candidateUrl.includes('kahoot.it/join') ||
    (isSupportedHost && candidateUrl.includes('/join')) ||
    isKahootActiveGameplayUrl(candidateUrl);

  if (shouldWarmup) {
    const settings = await getFastSettings();
    if (settings.enabled) {
      if (
        settings.triggerMode !== 'highlight_only' &&
        isKahootActiveGameplayUrl(candidateUrl)
      ) {
        void preattachDebuggerToTab(tabId);
      }
      void warmupProviderConnections(settings);
    }
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'scan-page-questions') {
    await triggerUniversalScanOnTab(tab?.id);
    return;
  }

  if (command === 'trigger-vision-fallback') {
    const targetTab = await findTargetKahootTab(tab);
    if (!targetTab || typeof targetTab.id !== 'number') {
      return;
    }

    const manualHash = buildQuestionStateHash(
      Date.now(),
      'manual-shortcut-vision',
      [],
      'vision'
    );
    const result = await handleExplicitVisionFallback(
      manualHash,
      -1,
      4,
      false,
      targetTab.id,
      targetTab.windowId,
      undefined,
      undefined,
      targetTab.url
    );

    if (result.ok && result.resolution) {
      await sendContentPushSafe(targetTab.id, {
        type: 'APPLY_RESOLVED_ANSWER',
        resolution: result.resolution,
      });
    }
    return;
  }

  if (command === 'trigger-clipboard-vision') {
    const settings = await getFastSettings();
    const targetTab = await findTargetKahootTab(tab);
    if (
      targetTab &&
      typeof targetTab.id === 'number' &&
      settings.highlightStyle !== 'stealth'
    ) {
      await sendContentPushSafe(targetTab.id, {
        type: 'CLIPBOARD_STATUS_TOAST',
        message: '⚡ Solving from Clipboard...',
      });
    }

    const clipHash = buildQuestionStateHash(
      Date.now(),
      'manual-shortcut-clipboard',
      [],
      'vision'
    );
    const result = await handleClipboardVisionRequest(
      clipHash,
      -1,
      4,
      false,
      targetTab?.id,
      undefined,
      undefined,
      undefined,
      targetTab?.url
    );

    if (targetTab && typeof targetTab.id === 'number') {
      if (result.ok && result.resolution) {
        await sendContentPushSafe(targetTab.id, {
          type: 'APPLY_RESOLVED_ANSWER',
          resolution: result.resolution,
        });
        if (settings.highlightStyle !== 'stealth') {
          const label =
            result.resolution.questionKind === 'fill_blank' &&
            result.resolution.fillText
              ? `"${result.resolution.fillText}"`
              : `[${result.resolution.indices.join(', ')}]`;
          await sendContentPushSafe(targetTab.id, {
            type: 'CLIPBOARD_STATUS_TOAST',
            message: `⚡ Clipboard → ${label} (${result.resolution.latencyMs}ms)`,
          });
        }
      } else if (settings.highlightStyle !== 'stealth') {
        await sendContentPushSafe(targetTab.id, {
          type: 'CLIPBOARD_STATUS_TOAST',
          message: result.error ?? 'Clipboard Vision failed',
          isError: true,
        });
      }
    }
  }
});

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeRequestMessage | { target?: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (
      response:
        | RuntimeResolveResponse
        | RuntimeBatchResolveResponse
        | RuntimeCacheResponse
        | RuntimeStatusResponse
        | RuntimeClickResponse
        | RuntimeScanResponse
        | { ok: boolean }
    ) => void
  ) => {
    if (!message || typeof message !== 'object' || 'target' in message) {
      return false;
    }

    const runtimeMsg = message as RuntimeRequestMessage;

    (async () => {
      switch (runtimeMsg.type) {
        case 'RESOLVE_QUESTION': {
          const res = await handleQuestionResolution(
            runtimeMsg.payload,
            sender.tab?.id,
            sender.tab?.windowId,
            sender.tab?.url,
            sender.frameId
          );
          sendResponse(res);
          break;
        }
        case 'RESOLVE_QUESTION_BATCH': {
          const batchRes = await handleBatchQuestionResolution(
            runtimeMsg.payload,
            sender.tab?.id,
            sender.frameId
          );
          sendResponse(batchRes);
          break;
        }
        case 'BROADCAST_HOST_QUESTION': {
          const res = await handleQuestionResolution(
            runtimeMsg.payload,
            undefined,
            sender.tab?.windowId,
            'https://play.kahoot.it/'
          );
          if (res.ok && res.resolution) {
            latestHostBroadcastResolution = res.resolution;
            await broadcastResolutionToPlayerTabs(
              res.resolution,
              sender.tab?.id
            );
          }
          sendResponse(res);
          break;
        }
        case 'QUERY_HOST_BROADCAST': {
          const fresh = getFreshHostBroadcastResolution();
          if (fresh) {
            const settings = await getFastSettings();
            const enriched = attachTriggerSettings(
              fresh,
              settings,
              Boolean(fresh.multiSelect)
            );
            sendResponse({ ok: true, resolution: enriched });
          } else {
            sendResponse({ ok: false });
          }
          break;
        }
        case 'EXEC_DIRECT_MAIN_CLICK': {
          const clickRes = await executeTrustedClickInTab(
            sender.tab?.id,
            runtimeMsg.indices,
            runtimeMsg.multiSelect,
            Boolean(runtimeMsg.submitOnly)
          );
          sendResponse(clickRes);
          break;
        }
        case 'EXEC_DIRECT_TEXT_FILL': {
          const fillRes = await executeTrustedTextFillInTab(
            sender.tab?.id,
            runtimeMsg.fillText,
            runtimeMsg.autoSubmit
          );
          sendResponse(fillRes);
          break;
        }
        case 'LEARN_VERIFIED_ANSWER': {
          await recordLearnedAnswer(
            runtimeMsg.questionText,
            runtimeMsg.options,
            runtimeMsg.indices,
            true,
            runtimeMsg.fillText
          );
          sendResponse({ ok: true });
          break;
        }
        case 'TRIGGER_VISION_FALLBACK': {
          const targetTab =
            sender.tab ?? (await findTargetKahootTab(undefined));
          const res = await handleExplicitVisionFallback(
            runtimeMsg.stateHash,
            runtimeMsg.questionIndex,
            runtimeMsg.optionCount,
            runtimeMsg.multiSelect,
            targetTab?.id,
            targetTab?.windowId,
            runtimeMsg.questionKind,
            runtimeMsg.blankLengthHint,
            targetTab?.url
          );
          sendResponse(res);
          break;
        }
        case 'TRIGGER_CLIPBOARD_VISION': {
          const targetTab =
            sender.tab ?? (await findTargetKahootTab(undefined));
          const res = await handleClipboardVisionRequest(
            runtimeMsg.stateHash,
            runtimeMsg.questionIndex,
            runtimeMsg.optionCount,
            runtimeMsg.multiSelect,
            targetTab?.id,
            undefined,
            runtimeMsg.questionKind,
            runtimeMsg.blankLengthHint,
            targetTab?.url
          );
          sendResponse(res);
          break;
        }
        case 'RESOLVE_DIRECT_CLIPBOARD_PAYLOAD': {
          const res = await handleClipboardVisionRequest(
            runtimeMsg.stateHash,
            runtimeMsg.questionIndex,
            runtimeMsg.optionCount,
            runtimeMsg.multiSelect,
            sender.tab?.id,
            runtimeMsg.clipboard,
            runtimeMsg.questionKind,
            runtimeMsg.blankLengthHint,
            sender.tab?.url
          );
          sendResponse(res);
          break;
        }
        case 'TRIGGER_UNIVERSAL_SCAN': {
          const scanRes = await triggerUniversalScanOnTab(
            runtimeMsg.tabId ?? sender.tab?.id
          );
          sendResponse(scanRes);
          break;
        }
        case 'PREFETCH_QUIZ_CACHE': {
          const res = await prefetchAndCacheQuiz(runtimeMsg.quizIdInput, true);
          if (res.livePinOnly) {
            const settings = await getFastSettings();
            await warmupProviderConnections(settings);
            let joinedTab = false;
            if (runtimeMsg.openLivePinTab && res.quizId) {
              joinedTab = await openOrNavigateLivePinJoinTab(res.quizId);
            }
            sendResponse({
              ...res,
              joinedTab,
              message: joinedTab
                ? `Opened kahoot.it/?pin=${res.quizId} & warmed up AI! (Live PINs have no UUID — AI auto-solves & clicks in game).`
                : `Live PIN ${res.quizId ?? ''} verified & AI warmed up! (Live PINs have no UUID — AI auto-solves in game).`,
            });
            break;
          }
          sendResponse(res);
          break;
        }
        case 'INGEST_QUIZ_PAYLOAD': {
          const res = await ingestKahootRestPayload(
            runtimeMsg.quizId,
            runtimeMsg.payload
          );
          sendResponse(res);
          break;
        }
        case 'CLEAR_QUIZ_CACHE': {
          await clearTier1Cache();
          sendResponse({ ok: true });
          break;
        }
        case 'WARMUP_CONNECTIONS': {
          const settings = await getFastSettings();
          if (
            settings.enabled &&
            settings.triggerMode !== 'highlight_only' &&
            typeof sender.tab?.id === 'number' &&
            isKahootActiveGameplayUrl(sender.tab.url)
          ) {
            void preattachDebuggerToTab(sender.tab.id);
          }
          void warmupProviderConnections(settings);
          sendResponse({ ok: true });
          break;
        }
        case 'QUIZ_ID_DETECTED': {
          const res = await prefetchAndCacheQuiz(runtimeMsg.quizId);
          sendResponse(res);
          break;
        }
        case 'GET_ENGINE_STATUS': {
          void ensureContentScriptsOnOpenKahootTabs();
          const [settings, telemetry, learnedCount] = await Promise.all([
            loadSettings(),
            loadTelemetry(),
            getLearnedQuestionCount(),
          ]);
          hotSettingsCache = settings;
          sendResponse({
            ok: true,
            settings,
            telemetry: {
              ...telemetry,
              learnedQuestionCount: learnedCount,
            },
          });
          break;
        }
        default: {
          sendResponse({ ok: false });
        }
      }
    })();

    return true;
  }
);
