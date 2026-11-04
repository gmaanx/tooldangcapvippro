import {
  DEFAULT_SETTINGS,
  DEFAULT_TELEMETRY,
  STORAGE_KEYS,
} from '../shared/constants';
import { buildQuestionStateHash, extractUuid } from '../shared/normalize';
import {
  loadSettings,
  loadTelemetry,
  updateTelemetry,
} from '../shared/storage';
import type {
  AnswerResolution,
  ClipboardExtractedPayload,
  ContentPushMessage,
  EngineSettings,
  QuestionPayload,
  RuntimeCacheResponse,
  RuntimeClickResponse,
  RuntimeRequestMessage,
  RuntimeResolveResponse,
  RuntimeStatusResponse,
} from '../shared/types';
import { raceParallelInference, warmupProviderConnections } from './ai-racer';
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
  lookupTier1Cache,
  prefetchAndCacheQuiz,
  recordLearnedAnswer,
} from './quiz-cache';
import {
  clearUserCanceledCooldown,
  detachAllDebuggerTabs,
  detachDebuggerFromTab,
  executeTrustedClickInTab,
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
  message: ContentPushMessage
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, message);
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
  multiSelect: boolean
): AnswerResolution {
  return {
    ...resolution,
    multiSelect,
    triggerMode: settings.triggerMode,
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
  return (
    url.startsWith('https://kahoot.it/') ||
    url.startsWith('https://play.kahoot.it/')
  );
}

async function findTargetKahootTab(
  preferredTab?: chrome.tabs.Tab
): Promise<chrome.tabs.Tab | undefined> {
  if (
    preferredTab &&
    typeof preferredTab.id === 'number' &&
    isKahootPlayableUrl(preferredTab.url)
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
    isKahootPlayableUrl(focusedTab.url)
  ) {
    return focusedTab;
  }

  const kahootTabs = await chrome.tabs.query({
    url: ['https://kahoot.it/*', 'https://play.kahoot.it/*'],
  });
  const activeKahootTab = kahootTabs.find(
    (item) => item.active && typeof item.id === 'number'
  );
  if (activeKahootTab) {
    return activeKahootTab;
  }

  return kahootTabs.find((item) => typeof item.id === 'number') ?? focusedTab;
}

async function ensureContentScriptsOnOpenKahootTabs(): Promise<void> {
  try {
    const settings = await getFastSettings();
    const openTabs = await chrome.tabs.query({
      url: [
        'https://kahoot.it/*',
        'https://play.kahoot.it/*',
        'https://create.kahoot.it/*',
      ],
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

async function handleQuestionResolution(
  payload: QuestionPayload,
  senderTabId: number | undefined,
  senderWindowId: number | undefined
): Promise<RuntimeResolveResponse> {
  const settings = await getFastSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'KahootHybridEngine is currently paused.',
    };
  }

  const finalizeResolution = (base: AnswerResolution): RuntimeResolveResponse => {
    const enriched = attachTriggerSettings(base, settings, payload.multiSelect);
    if (
      settings.triggerMode === 'instant_auto_click' &&
      !payload.multiSelect &&
      typeof senderTabId === 'number'
    ) {
      void executeTrustedClickInTab(
        senderTabId,
        enriched.indices,
        false,
        false
      );
    }
    return { ok: true, resolution: enriched };
  };

  const startedAt = performance.now();

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
    payload.questionText,
    payload.options
  );

  if (learnedIndices && learnedIndices.length > 0) {
    const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
    const resolution: AnswerResolution = {
      stateHash: payload.stateHash,
      questionIndex: payload.questionIndex,
      indices: learnedIndices,
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

  if (hasReadableQuestion && hasReadableOptions) {
    try {
      const raceWinner = await raceParallelInference(payload, settings);
      const resolution: AnswerResolution = {
        stateHash: payload.stateHash,
        questionIndex: payload.questionIndex,
        indices: raceWinner.indices,
        tier: raceWinner.tier,
        latencyMs: raceWinner.latencyMs,
        timestamp: Date.now(),
        voteSummary: raceWinner.voteSummary,
      };

      void recordLearnedAnswer(
        payload.questionText,
        payload.options,
        raceWinner.indices,
        false
      );

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

  try {
    const visionResult = await resolveViaVisionCapture(
      senderWindowId,
      payload.optionCount,
      payload.multiSelect,
      settings
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
  windowId: number | undefined
): Promise<RuntimeResolveResponse> {
  const settings = await getFastSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'KahootHybridEngine is currently paused.',
    };
  }

  try {
    const visionResult = await resolveViaVisionCapture(
      windowId,
      optionCount,
      multiSelect,
      settings
    );
    if (visionResult.hostOnlyBlank) {
      return {
        ok: false,
        hostOnlyBlank: true,
        error:
          'Host-Only screen: use Win+Shift+S then Alt+Shift+V (or Ctrl+V).',
      };
    }

    const resolution = attachTriggerSettings(
      {
        stateHash,
        questionIndex,
        indices: visionResult.indices,
        tier: 'tier4_vision',
        latencyMs: visionResult.latencyMs,
        timestamp: Date.now(),
      },
      settings,
      multiSelect
    );

    if (
      settings.triggerMode === 'instant_auto_click' &&
      !multiSelect &&
      typeof tabId === 'number'
    ) {
      void executeTrustedClickInTab(tabId, resolution.indices, false, false);
    }

    void Promise.all([
      updateTelemetry({
        lastTier: 'tier4_vision',
        lastLatencyMs: visionResult.latencyMs,
        lastIndices: visionResult.indices,
        lastQuestionHash: stateHash,
        lastError: null,
      }),
      setBadgeFeedback(visionResult.indices.join(','), '#9333EA'),
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
  directPayload?: ClipboardExtractedPayload
): Promise<RuntimeResolveResponse> {
  const settings = await getFastSettings();
  if (!settings.enabled) {
    return {
      ok: false,
      error: 'KahootHybridEngine is currently paused.',
    };
  }

  try {
    const clipboardResult = directPayload
      ? await resolveFromClipboardPayload(
          directPayload,
          optionCount,
          multiSelect,
          settings
        )
      : await resolveViaSystemClipboard(optionCount, multiSelect, settings);

    const resolution = attachTriggerSettings(
      {
        stateHash,
        questionIndex,
        indices: clipboardResult.indices,
        tier: 'tier4_clipboard',
        latencyMs: clipboardResult.latencyMs,
        timestamp: Date.now(),
      },
      settings,
      multiSelect
    );

    if (
      settings.triggerMode === 'instant_auto_click' &&
      !multiSelect &&
      typeof tabId === 'number'
    ) {
      void executeTrustedClickInTab(tabId, resolution.indices, false, false);
    }

    void Promise.all([
      updateTelemetry({
        lastTier: 'tier4_clipboard',
        lastLatencyMs: clipboardResult.latencyMs,
        lastIndices: clipboardResult.indices,
        lastQuestionHash: stateHash,
        lastError: null,
      }),
      setBadgeFeedback(clipboardResult.indices.join(','), '#EA580C'),
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

  const shouldWarmup =
    candidateUrl.includes('play.kahoot.it/v2/lobby') ||
    candidateUrl.includes('kahoot.it/instructions') ||
    candidateUrl.includes('kahoot.it/join') ||
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
      await warmupProviderConnections(settings);
    }
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
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
      targetTab.windowId
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
    const targetTab = await findTargetKahootTab(tab);
    if (targetTab && typeof targetTab.id === 'number') {
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
      targetTab?.id
    );

    if (targetTab && typeof targetTab.id === 'number') {
      if (result.ok && result.resolution) {
        await sendContentPushSafe(targetTab.id, {
          type: 'APPLY_RESOLVED_ANSWER',
          resolution: result.resolution,
        });
        await sendContentPushSafe(targetTab.id, {
          type: 'CLIPBOARD_STATUS_TOAST',
          message: `⚡ Clipboard → [${result.resolution.indices.join(', ')}] (${result.resolution.latencyMs}ms)`,
        });
      } else {
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
        | RuntimeCacheResponse
        | RuntimeStatusResponse
        | RuntimeClickResponse
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
            sender.tab?.windowId
          );
          sendResponse(res);
          break;
        }
        case 'BROADCAST_HOST_QUESTION': {
          const res = await handleQuestionResolution(
            runtimeMsg.payload,
            undefined,
            sender.tab?.windowId
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
        case 'LEARN_VERIFIED_ANSWER': {
          await recordLearnedAnswer(
            runtimeMsg.questionText,
            runtimeMsg.options,
            runtimeMsg.indices,
            true
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
            targetTab?.windowId
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
            targetTab?.id
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
            runtimeMsg.clipboard
          );
          sendResponse(res);
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
          await warmupProviderConnections(settings);
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
