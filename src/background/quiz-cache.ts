import { API_ENDPOINTS, STORAGE_KEYS } from '../shared/constants';
import {
  extractGamePin,
  extractUuid,
  normalizeQuestionText,
} from '../shared/normalize';
import {
  clearSerializedQuizCache,
  loadSerializedQuizCache,
  saveSerializedQuizCache,
  saveSettings,
  updateTelemetry,
} from '../shared/storage';
import type {
  KahootChallengePinPayload,
  KahootRestPayload,
  LearnedQuestionEntry,
  RuntimeCacheResponse,
  SerializedLearnedCache,
  SerializedQuizCache,
} from '../shared/types';

const FAILED_FETCH_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_LEARNED_ENTRIES = 1500;

let activeCachedQuizId = '';
let isMemoryHydrated = false;
let isLearnedHydrated = false;
const questionIndexCache = new Map<string, number[]>();
const questionChoiceTextCache = new Map<string, string[]>();
const learnedCache = new Map<string, LearnedQuestionEntry>();
const inFlightPrefetches = new Map<string, Promise<RuntimeCacheResponse>>();
const failedQuizTimestamps = new Map<string, number>();

function populateMemoryMaps(serialized: SerializedQuizCache): void {
  questionIndexCache.clear();
  questionChoiceTextCache.clear();
  for (const [normQuestion, indices] of serialized.indexEntries) {
    questionIndexCache.set(normQuestion, indices);
  }
  for (const [normQuestion, choiceTexts] of serialized.choiceTextEntries) {
    questionChoiceTextCache.set(normQuestion, choiceTexts);
  }
  activeCachedQuizId = serialized.quizId;
  isMemoryHydrated = true;
}

export async function ensureQuizCacheHydrated(): Promise<void> {
  if (isMemoryHydrated) {
    return;
  }
  const serialized = await loadSerializedQuizCache();
  if (serialized) {
    populateMemoryMaps(serialized);
  } else {
    isMemoryHydrated = true;
  }
}

export async function ensureLearnedCacheHydrated(): Promise<void> {
  if (isLearnedHydrated) {
    return;
  }
  try {
    const stored = await chrome.storage.local.get(
      STORAGE_KEYS.LEARNED_CACHE_LOCAL
    );
    const raw = stored[STORAGE_KEYS.LEARNED_CACHE_LOCAL] as
      | SerializedLearnedCache
      | undefined;
    if (raw && Array.isArray(raw.entries)) {
      learnedCache.clear();
      for (const [normQuestion, entry] of raw.entries) {
        if (
          typeof normQuestion === 'string' &&
          normQuestion.length > 0 &&
          entry &&
          (Array.isArray(entry.indices) || typeof entry.fillText === 'string')
        ) {
          learnedCache.set(normQuestion, {
            choiceTexts: Array.isArray(entry.choiceTexts) ? entry.choiceTexts : [],
            indices: Array.isArray(entry.indices) ? entry.indices : [],
            fillText: typeof entry.fillText === 'string' ? entry.fillText : undefined,
            verified: Boolean(entry.verified),
            updatedAt: Number(entry.updatedAt) || Date.now(),
          });
        }
      }
    }
  } catch {
    void 0;
  }
  isLearnedHydrated = true;
}

export async function getLearnedQuestionCount(): Promise<number> {
  await ensureLearnedCacheHydrated();
  return learnedCache.size;
}

export async function lookupLearnedCache(
  questionText: string,
  liveOptions: string[]
): Promise<number[] | null> {
  await ensureLearnedCacheHydrated();
  if (learnedCache.size === 0) {
    return null;
  }

  const normQuestion = normalizeQuestionText(questionText);
  if (!normQuestion) {
    return null;
  }

  const entry = learnedCache.get(normQuestion);
  if (!entry) {
    return null;
  }

  const normalizedLiveOptions = liveOptions
    .map((opt) => normalizeQuestionText(opt))
    .filter((opt) => opt.length > 0);

  if (entry.choiceTexts.length > 0 && normalizedLiveOptions.length > 0) {
    const matchedIndices: number[] = [];
    liveOptions.forEach((rawOpt, liveIdx) => {
      const normOpt = normalizeQuestionText(rawOpt);
      if (normOpt && entry.choiceTexts.includes(normOpt)) {
        matchedIndices.push(liveIdx);
      }
    });
    if (matchedIndices.length > 0) {
      return matchedIndices;
    }
    return null;
  }

  if (entry.indices.length > 0) {
    if (liveOptions.length > 0) {
      const bounded = entry.indices.filter(
        (idx) => idx >= 0 && idx < liveOptions.length
      );
      return bounded.length > 0 ? bounded : null;
    }
    return [...entry.indices];
  }

  return null;
}

export async function lookupLearnedFillBlank(
  questionText: string
): Promise<string | null> {
  await ensureLearnedCacheHydrated();
  if (learnedCache.size === 0) {
    return null;
  }
  const normQuestion = normalizeQuestionText(questionText);
  if (!normQuestion) {
    return null;
  }
  const entry = learnedCache.get(normQuestion);
  if (entry && typeof entry.fillText === 'string' && entry.fillText.trim().length > 0) {
    return entry.fillText.trim();
  }
  return null;
}

export async function recordLearnedAnswer(
  questionText: string,
  options: string[],
  indices: number[],
  verified: boolean,
  fillText?: string
): Promise<void> {
  const normQuestion = normalizeQuestionText(questionText);
  const cleanFill = typeof fillText === 'string' ? fillText.trim() : '';
  if (normQuestion.length < 3 || (indices.length === 0 && cleanFill.length === 0)) {
    return;
  }

  await ensureLearnedCacheHydrated();

  const existing = learnedCache.get(normQuestion);
  if (existing && existing.verified && !verified) {
    return;
  }

  const choiceTexts: string[] = [];
  for (const idx of indices) {
    const rawChoice = options[idx] ?? '';
    const normChoice = normalizeQuestionText(rawChoice);
    if (normChoice && !choiceTexts.includes(normChoice)) {
      choiceTexts.push(normChoice);
    }
  }

  const finalChoiceTexts =
    choiceTexts.length > 0 ? choiceTexts : (existing?.choiceTexts ?? []);
  const finalFillText =
    cleanFill.length > 0 ? cleanFill : existing?.fillText;

  learnedCache.delete(normQuestion);
  learnedCache.set(normQuestion, {
    choiceTexts: finalChoiceTexts,
    indices: [...indices],
    fillText: finalFillText,
    verified: verified || Boolean(existing?.verified),
    updatedAt: Date.now(),
  });

  while (learnedCache.size > MAX_LEARNED_ENTRIES) {
    const oldestKey = learnedCache.keys().next().value;
    if (typeof oldestKey === 'string') {
      learnedCache.delete(oldestKey);
    } else {
      break;
    }
  }

  const payload: SerializedLearnedCache = {
    entries: Array.from(learnedCache.entries()),
  };

  try {
    await Promise.all([
      chrome.storage.local.set({ [STORAGE_KEYS.LEARNED_CACHE_LOCAL]: payload }),
      updateTelemetry({ learnedQuestionCount: learnedCache.size }),
    ]);
  } catch {
    return;
  }
}

export function isQuizUuidAlreadyCached(quizIdInput: string): boolean {
  const uuid = extractUuid(quizIdInput);
  return Boolean(
    uuid &&
      isMemoryHydrated &&
      activeCachedQuizId === uuid &&
      questionIndexCache.size > 0
  );
}

export async function lookupTier1Cache(
  questionText: string,
  liveOptions: string[]
): Promise<number[] | null> {
  await ensureQuizCacheHydrated();
  if (questionIndexCache.size === 0) {
    return null;
  }

  const normQuestion = normalizeQuestionText(questionText);
  if (!normQuestion) {
    return null;
  }

  const cachedChoiceTexts = questionChoiceTextCache.get(normQuestion);
  const normalizedLiveOptions = liveOptions
    .map((opt) => normalizeQuestionText(opt))
    .filter((opt) => opt.length > 0);

  if (
    cachedChoiceTexts &&
    cachedChoiceTexts.length > 0 &&
    normalizedLiveOptions.length > 0
  ) {
    const matchedLiveIndices: number[] = [];
    liveOptions.forEach((rawOpt, liveIdx) => {
      const normLive = normalizeQuestionText(rawOpt);
      if (normLive && cachedChoiceTexts.includes(normLive)) {
        matchedLiveIndices.push(liveIdx);
      }
    });
    if (matchedLiveIndices.length > 0) {
      return matchedLiveIndices;
    }
  }

  const directIndices = questionIndexCache.get(normQuestion);
  if (directIndices && directIndices.length > 0) {
    return [...directIndices];
  }

  return null;
}

export async function ingestKahootRestPayload(
  quizIdInput: string,
  data: KahootRestPayload
): Promise<RuntimeCacheResponse> {
  const resolvedId =
    extractUuid(quizIdInput) ??
    extractUuid(String(data.uuid ?? '')) ??
    extractGamePin(quizIdInput) ??
    quizIdInput.trim();

  if (!resolvedId) {
    return {
      ok: false,
      error: 'Invalid quiz identifier.',
    };
  }

  const questions = Array.isArray(data.questions) ? data.questions : [];
  const nextIndexMap = new Map<string, number[]>();
  const nextChoiceTextMap = new Map<string, string[]>();

  for (const item of questions) {
    const rawQuestion = item.question ?? item.title ?? '';
    const normQuestion = normalizeQuestionText(rawQuestion);
    if (!normQuestion || !Array.isArray(item.choices)) {
      continue;
    }

    const correctIndices: number[] = [];
    const correctTexts: string[] = [];

    item.choices.forEach((choice, idx) => {
      if (choice && choice.correct === true) {
        correctIndices.push(idx);
        const normChoice = normalizeQuestionText(choice.answer ?? '');
        if (normChoice) {
          correctTexts.push(normChoice);
        }
      }
    });

    if (correctIndices.length > 0) {
      nextIndexMap.set(normQuestion, correctIndices);
      if (correctTexts.length > 0) {
        nextChoiceTextMap.set(normQuestion, correctTexts);
      }
    }
  }

  if (nextIndexMap.size === 0) {
    return {
      ok: false,
      error: 'Quiz payload contained 0 answerable questions.',
    };
  }

  const serialized: SerializedQuizCache = {
    quizId: resolvedId,
    title: typeof data.title === 'string' ? data.title : 'Kahoot Quiz',
    questionCount: nextIndexMap.size,
    indexEntries: Array.from(nextIndexMap.entries()),
    choiceTextEntries: Array.from(nextChoiceTextMap.entries()),
    fetchedAt: Date.now(),
  };

  failedQuizTimestamps.delete(resolvedId);
  populateMemoryMaps(serialized);
  await Promise.all([
    saveSerializedQuizCache(serialized),
    saveSettings({ quizId: resolvedId }),
    updateTelemetry({
      cachedQuizId: resolvedId,
      cachedQuizTitle: serialized.title,
      cachedQuestionCount: serialized.questionCount,
      lastError: null,
    }),
  ]);

  return {
    ok: true,
    quizId: resolvedId,
    title: serialized.title,
    questionCount: serialized.questionCount,
  };
}

async function executePrefetchAcrossEndpoints(
  extractedUuid: string
): Promise<RuntimeCacheResponse> {
  const candidateUrls = [
    `${API_ENDPOINTS.KAHOOT_REST_BASE}/${extractedUuid}`,
    `${API_ENDPOINTS.KAHOOT_CREATE_REST_BASE}/${extractedUuid}`,
    `${API_ENDPOINTS.KAHOOT_PLAYER_REST_BASE}/${extractedUuid}`,
  ];

  let lastStatus = 0;

  for (const endpoint of candidateUrls) {
    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
        },
      });

      lastStatus = response.status;
      if (!response.ok) {
        continue;
      }

      const data = (await response.json()) as KahootRestPayload;
      if (Array.isArray(data.questions) && data.questions.length > 0) {
        return await ingestKahootRestPayload(extractedUuid, data);
      }
    } catch {
      continue;
    }
  }

  failedQuizTimestamps.set(extractedUuid, Date.now());
  const errorMsg =
    lastStatus === 401 || lastStatus === 403
      ? `HTTP ${lastStatus} Forbidden: Quiz is Private or requires Kahoot login (Tier 3 AI & Tier 4 Vision remain active).`
      : lastStatus > 0
        ? `Kahoot REST returned HTTP ${lastStatus}`
        : 'Quiz cache pre-fetch failed due to network error.';

  await updateTelemetry({ lastError: errorMsg });
  return {
    ok: false,
    error: errorMsg,
  };
}

async function resolveByGamePin(gamePin: string): Promise<RuntimeCacheResponse> {
  try {
    const challengeRes = await fetch(
      `${API_ENDPOINTS.KAHOOT_CHALLENGE_PIN_BASE}/${gamePin}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (challengeRes.ok) {
      const challengeData =
        (await challengeRes.json()) as KahootChallengePinPayload;
      if (
        challengeData.kahoot &&
        Array.isArray(challengeData.kahoot.questions) &&
        challengeData.kahoot.questions.length > 0
      ) {
        const targetId =
          challengeData.kahoot.uuid ??
          challengeData.challenge?.quizId ??
          gamePin;
        return await ingestKahootRestPayload(targetId, challengeData.kahoot);
      }

      const linkedUuid = extractUuid(
        String(
          challengeData.challenge?.quizId ??
            challengeData.challenge?.kahootId ??
            ''
        )
      );
      if (linkedUuid) {
        return await executePrefetchAcrossEndpoints(linkedUuid);
      }
    }
  } catch {
    void 0;
  }

  try {
    const liveRes = await fetch(
      `${API_ENDPOINTS.KAHOOT_LIVE_RESERVE_BASE}/${gamePin}/?${Date.now()}`,
      {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
        },
      }
    );

    if (liveRes.ok) {
      const liveData = (await liveRes.json()) as Record<string, unknown>;
      const embeddedUuid = extractUuid(
        String(liveData.quizId ?? liveData.quizUuid ?? '')
      );
      if (embeddedUuid) {
        return await executePrefetchAcrossEndpoints(embeddedUuid);
      }

      const infoMsg = `Live PIN ${gamePin} verified! Kahoot does not expose answers via Live PIN — enter PIN on kahoot.it and Tier 3 AI / Tier 4 Vision will auto-solve each question.`;
      await Promise.all([
        saveSettings({ quizId: gamePin }),
        updateTelemetry({ lastError: null }),
      ]);
      return {
        ok: true,
        livePinOnly: true,
        quizId: gamePin,
        questionCount: 0,
        message: infoMsg,
      };
    }
  } catch {
    void 0;
  }

  const notFoundMsg = `PIN ${gamePin} not found as an active Live room or Challenge.`;
  await updateTelemetry({ lastError: notFoundMsg });
  return {
    ok: false,
    error: notFoundMsg,
  };
}

export async function prefetchAndCacheQuiz(
  quizIdInput: string,
  force = false
): Promise<RuntimeCacheResponse> {
  const extractedUuid = extractUuid(quizIdInput);
  const extractedPin = extractedUuid ? null : extractGamePin(quizIdInput);

  if (!extractedUuid && !extractedPin) {
    return {
      ok: false,
      error: 'Enter a valid 5–10 digit Game PIN, Challenge link, or Quiz UUID.',
    };
  }

  await ensureQuizCacheHydrated();

  if (extractedPin) {
    const existingPinTask = inFlightPrefetches.get(extractedPin);
    if (existingPinTask) {
      return existingPinTask;
    }
    const pinTask = resolveByGamePin(extractedPin);
    inFlightPrefetches.set(extractedPin, pinTask);
    try {
      return await pinTask;
    } finally {
      inFlightPrefetches.delete(extractedPin);
    }
  }

  const targetUuid = extractedUuid as string;

  if (
    isMemoryHydrated &&
    activeCachedQuizId === targetUuid &&
    questionIndexCache.size > 0
  ) {
    return {
      ok: true,
      quizId: targetUuid,
      questionCount: questionIndexCache.size,
    };
  }

  if (!force) {
    const failedAt = failedQuizTimestamps.get(targetUuid) ?? 0;
    if (Date.now() - failedAt < FAILED_FETCH_COOLDOWN_MS) {
      return {
        ok: false,
        error: 'Skipped retry during cooldown for restricted quizId.',
      };
    }
  }

  const existingPromise = inFlightPrefetches.get(targetUuid);
  if (existingPromise) {
    return existingPromise;
  }

  const task = executePrefetchAcrossEndpoints(targetUuid);
  inFlightPrefetches.set(targetUuid, task);
  try {
    return await task;
  } finally {
    inFlightPrefetches.delete(targetUuid);
  }
}

export async function clearTier1Cache(): Promise<void> {
  questionIndexCache.clear();
  questionChoiceTextCache.clear();
  failedQuizTimestamps.clear();
  activeCachedQuizId = '';
  isMemoryHydrated = true;
  await Promise.all([
    clearSerializedQuizCache(),
    saveSettings({ quizId: '' }),
    updateTelemetry({
      cachedQuizId: '',
      cachedQuizTitle: '',
      cachedQuestionCount: 0,
      lastError: null,
    }),
  ]);
}
