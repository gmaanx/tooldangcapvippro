import {
  DEFAULT_SETTINGS,
  DEFAULT_TELEMETRY,
  STORAGE_KEYS,
  TARGET_SCORE_MAX,
  TARGET_SCORE_MIN,
  VISION_LOCK_TTL_MS,
} from './constants';
import type {
  EngineSettings,
  EngineTelemetry,
  SerializedQuizCache,
} from './types';

interface VisionLockRecord {
  state: 'idle' | 'capturing';
  updatedAt: number;
}

export async function loadSettings(): Promise<EngineSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const raw = stored[STORAGE_KEYS.SETTINGS] as Partial<EngineSettings> | undefined;
  if (!raw) {
    return { ...DEFAULT_SETTINGS };
  }
  const minDelayMs = Number.isFinite(raw.minDelayMs)
    ? Math.max(0, Math.round(Number(raw.minDelayMs)))
    : DEFAULT_SETTINGS.minDelayMs;
  const maxDelayCandidate = Number.isFinite(raw.maxDelayMs)
    ? Math.max(0, Math.round(Number(raw.maxDelayMs)))
    : DEFAULT_SETTINGS.maxDelayMs;
  const maxDelayMs = Math.max(minDelayMs, maxDelayCandidate);
  const targetScore = Number.isFinite(raw.targetScore)
    ? Math.min(
        TARGET_SCORE_MAX,
        Math.max(TARGET_SCORE_MIN, Math.round(Number(raw.targetScore)))
      )
    : DEFAULT_SETTINGS.targetScore;

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
    quizId: typeof raw.quizId === 'string' ? raw.quizId.trim() : DEFAULT_SETTINGS.quizId,
    groqApiKey:
      typeof raw.groqApiKey === 'string' ? raw.groqApiKey.trim() : DEFAULT_SETTINGS.groqApiKey,
    geminiApiKey:
      typeof raw.geminiApiKey === 'string'
        ? raw.geminiApiKey.trim()
        : DEFAULT_SETTINGS.geminiApiKey,
    openRouterApiKey:
      typeof raw.openRouterApiKey === 'string'
        ? raw.openRouterApiKey.trim()
        : DEFAULT_SETTINGS.openRouterApiKey,
    consensusMode:
      raw.consensusMode === 'fastest_first' ||
      raw.consensusMode === 'consensus_vote'
        ? raw.consensusMode
        : DEFAULT_SETTINGS.consensusMode,
    pinnedContext:
      typeof raw.pinnedContext === 'string'
        ? raw.pinnedContext
        : DEFAULT_SETTINGS.pinnedContext,
    triggerMode:
      raw.triggerMode === 'highlight_only' ||
      raw.triggerMode === 'instant_auto_click' ||
      raw.triggerMode === 'target_score' ||
      raw.triggerMode === 'smart_human_jitter'
        ? raw.triggerMode
        : DEFAULT_SETTINGS.triggerMode,
    targetScore,
    minDelayMs,
    maxDelayMs,
  };
}

export async function saveSettings(
  partial: Partial<EngineSettings>
): Promise<EngineSettings> {
  const current = await loadSettings();
  const merged: EngineSettings = {
    ...current,
    ...partial,
  };
  if (merged.maxDelayMs < merged.minDelayMs) {
    merged.maxDelayMs = merged.minDelayMs;
  }
  merged.targetScore = Math.min(
    TARGET_SCORE_MAX,
    Math.max(TARGET_SCORE_MIN, Math.round(merged.targetScore))
  );
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return merged;
}

export async function loadTelemetry(): Promise<EngineTelemetry> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.TELEMETRY);
  const raw = stored[STORAGE_KEYS.TELEMETRY] as Partial<EngineTelemetry> | undefined;
  return {
    ...DEFAULT_TELEMETRY,
    ...(raw ?? {}),
  };
}

export async function updateTelemetry(
  patch: Partial<EngineTelemetry>
): Promise<EngineTelemetry> {
  const current = await loadTelemetry();
  const next: EngineTelemetry = {
    ...current,
    ...patch,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.TELEMETRY]: next });
  return next;
}

export async function saveSerializedQuizCache(
  cache: SerializedQuizCache
): Promise<void> {
  await Promise.all([
    chrome.storage.session.set({ [STORAGE_KEYS.QUIZ_CACHE_SESSION]: cache }),
    chrome.storage.local.set({ [STORAGE_KEYS.QUIZ_CACHE_LOCAL]: cache }),
  ]);
}

export async function loadSerializedQuizCache(): Promise<SerializedQuizCache | null> {
  const sessionData = await chrome.storage.session.get(
    STORAGE_KEYS.QUIZ_CACHE_SESSION
  );
  const fromSession = sessionData[STORAGE_KEYS.QUIZ_CACHE_SESSION] as
    | SerializedQuizCache
    | undefined;
  if (fromSession && Array.isArray(fromSession.indexEntries)) {
    return fromSession;
  }

  const localData = await chrome.storage.local.get(STORAGE_KEYS.QUIZ_CACHE_LOCAL);
  const fromLocal = localData[STORAGE_KEYS.QUIZ_CACHE_LOCAL] as
    | SerializedQuizCache
    | undefined;
  if (fromLocal && Array.isArray(fromLocal.indexEntries)) {
    await chrome.storage.session.set({
      [STORAGE_KEYS.QUIZ_CACHE_SESSION]: fromLocal,
    });
    return fromLocal;
  }

  return null;
}

export async function clearSerializedQuizCache(): Promise<void> {
  await Promise.all([
    chrome.storage.session.remove(STORAGE_KEYS.QUIZ_CACHE_SESSION),
    chrome.storage.local.remove(STORAGE_KEYS.QUIZ_CACHE_LOCAL),
  ]);
}

export async function acquireVisionCaptureLock(): Promise<boolean> {
  const now = Date.now();
  const stored = await chrome.storage.session.get(STORAGE_KEYS.VISION_LOCK);
  const lock = stored[STORAGE_KEYS.VISION_LOCK] as VisionLockRecord | undefined;

  if (
    lock &&
    lock.state === 'capturing' &&
    now - lock.updatedAt < VISION_LOCK_TTL_MS
  ) {
    return false;
  }

  const nextLock: VisionLockRecord = {
    state: 'capturing',
    updatedAt: now,
  };
  await chrome.storage.session.set({ [STORAGE_KEYS.VISION_LOCK]: nextLock });
  return true;
}

export async function releaseVisionCaptureLock(): Promise<void> {
  const resetLock: VisionLockRecord = {
    state: 'idle',
    updatedAt: Date.now(),
  };
  await chrome.storage.session.set({ [STORAGE_KEYS.VISION_LOCK]: resetLock });
}
