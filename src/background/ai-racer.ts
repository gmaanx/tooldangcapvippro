import {
  API_ENDPOINTS,
  CONSENSUS_DECISION_WINDOW_MS,
  DEEP_CONSENSUS_WINDOW_MS,
  DEEP_INFERENCE_TIMEOUT_MS,
  GEMINI_API_REVISION,
  INFERENCE_TIMEOUT_MS,
  MODELS,
  STORAGE_KEYS,
  WARMUP_COOLDOWN_MS,
} from '../shared/constants';
import {
  computeFnv1aHash,
  normalizeQuestionText,
  parseAnswerIndices,
  parseBatchAnswerMap,
  parseFillBlankAnswer,
} from '../shared/normalize';
import { updateTelemetry } from '../shared/storage';
import type {
  AiProviderId,
  BatchItemResolution,
  BatchQuestionItem,
  EngineSettings,
  QuestionPayload,
  ResolutionTier,
} from '../shared/types';

export interface RaceResult {
  indices: number[];
  fillText?: string;
  tier: Extract<
    ResolutionTier,
    | 'tier3_consensus'
    | 'tier3_groq'
    | 'tier3_gemini'
    | 'tier3_openrouter'
    | 'tier3_local_ai'
  >;
  latencyMs: number;
  voteSummary?: string;
  disputed?: boolean;
  competingIndices?: number[][];
}

interface ChromeLanguageModelSession {
  prompt(input: string, options?: { signal?: AbortSignal }): Promise<string>;
  destroy(): void;
}

interface ChromeLanguageModelFactory {
  availability(options?: Record<string, unknown>): Promise<string>;
  create(options?: {
    temperature?: number;
    topK?: number;
    signal?: AbortSignal;
    initialPrompts?: Array<{ role: 'system' | 'user'; content: string }>;
  }): Promise<ChromeLanguageModelSession>;
}

declare global {
  interface GlobalThis {
    LanguageModel?: ChromeLanguageModelFactory;
  }
  var LanguageModel: ChromeLanguageModelFactory | undefined;
}

interface OpenAiContentPart {
  type?: string;
  text?: string;
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: {
      content?: string | OpenAiContentPart[] | null;
    };
  }>;
  error?: {
    message?: string;
    code?: string | number;
  };
  message?: string;
}

interface GroqModelsListResponse {
  data?: Array<{
    id?: string;
    active?: boolean;
  }>;
}

interface PersistedGroqModelState {
  keyHash: string;
  modelIds: string[];
  verifiedTextModel: string | null;
  verifiedVisionModel: string | null;
  updatedAt: number;
}

interface GeminiInteractionStepContent {
  type?: string;
  text?: string;
}

interface GeminiInteractionStep {
  type?: string;
  content?: GeminiInteractionStepContent[];
}

interface GeminiInteractionResponse {
  output_text?: string | null;
  steps?: GeminiInteractionStep[];
}

interface ConsensusVoterSpec {
  id: string;
  tier: RaceResult['tier'];
  weight: number;
  run: (signal: AbortSignal) => Promise<number[]>;
}

interface VoteBucket {
  indices: number[];
  count: number;
  totalWeight: number;
  firstLatencyMs: number;
  tier: RaceResult['tier'];
}

const GROQ_MODEL_CACHE_TTL_MS = 30 * 60 * 1000;
const AUTH_CIRCUIT_BREAKER_TTL_MS = 5 * 60 * 1000;
const NON_CHAT_MODEL_PATTERN =
  /(?:whisper|tts|orpheus|playai|guard|safeguard|embed|moderation|rerank)/i;
const REASONING_MODEL_PATTERN =
  /(?:gpt-oss|qwen|qwq|deepseek|r1|openrouter\/free)/i;
const VISION_CAPABLE_PATTERN = /(?:vision|llama-4|qwen3\.8)/i;

let groqStateHydrated = false;
let groqModelState: PersistedGroqModelState | null = null;
let groqModelsFetchInFlight: Promise<string[]> | null = null;
let verifiedOpenRouterModel: { keyHash: string; modelId: string } | null = null;

const authCircuitBreaker = new Map<
  string,
  { mutedUntil: number; message: string }
>();

function buildProviderKeyId(provider: AiProviderId, apiKey: string): string {
  return `${provider}:${computeFnv1aHash(apiKey)}`;
}

export function isProviderKeyMuted(
  provider: AiProviderId,
  apiKey: string
): string | null {
  if (!apiKey) {
    return null;
  }
  const keyId = buildProviderKeyId(provider, apiKey);
  const record = authCircuitBreaker.get(keyId);
  if (!record) {
    return null;
  }
  if (Date.now() >= record.mutedUntil) {
    authCircuitBreaker.delete(keyId);
    return null;
  }
  return record.message;
}

export function recordProviderAuthFailure(
  provider: AiProviderId,
  apiKey: string,
  status: number,
  message: string
): void {
  if (!apiKey || (status !== 401 && status !== 403)) {
    return;
  }
  const keyId = buildProviderKeyId(provider, apiKey);
  authCircuitBreaker.set(keyId, {
    mutedUntil: Date.now() + AUTH_CIRCUIT_BREAKER_TTL_MS,
    message,
  });
}

function extractOpenAiMessageText(
  rawContent: string | OpenAiContentPart[] | null | undefined
): string {
  if (typeof rawContent === 'string') {
    return rawContent.trim();
  }
  if (!Array.isArray(rawContent)) {
    return '';
  }
  const parts: string[] = [];
  for (const item of rawContent) {
    if (
      item &&
      typeof item === 'object' &&
      item.type !== 'thinking' &&
      typeof item.text === 'string'
    ) {
      parts.push(item.text);
    }
  }
  return parts.join(' ').trim();
}

async function ensureGroqModelStateHydrated(): Promise<void> {
  if (groqStateHydrated) {
    return;
  }
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.GROQ_MODEL_CACHE);
    const raw = stored[STORAGE_KEYS.GROQ_MODEL_CACHE] as
      | PersistedGroqModelState
      | undefined;
    if (raw && typeof raw.keyHash === 'string' && Array.isArray(raw.modelIds)) {
      groqModelState = raw;
    }
  } catch {
    void 0;
  }
  groqStateHydrated = true;
}

async function persistGroqModelState(
  next: PersistedGroqModelState
): Promise<void> {
  groqModelState = next;
  groqStateHydrated = true;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.GROQ_MODEL_CACHE]: next });
  } catch {
    return;
  }
}

async function recordVerifiedGroqModel(
  apiKey: string,
  kind: 'text' | 'vision',
  modelId: string
): Promise<void> {
  await ensureGroqModelStateHydrated();
  const keyHash = computeFnv1aHash(apiKey);
  const base: PersistedGroqModelState =
    groqModelState && groqModelState.keyHash === keyHash
      ? groqModelState
      : {
          keyHash,
          modelIds: [],
          verifiedTextModel: null,
          verifiedVisionModel: null,
          updatedAt: Date.now(),
        };

  if (kind === 'text' && base.verifiedTextModel === modelId) {
    return;
  }
  if (kind === 'vision' && base.verifiedVisionModel === modelId) {
    return;
  }

  await persistGroqModelState({
    ...base,
    verifiedTextModel: kind === 'text' ? modelId : base.verifiedTextModel,
    verifiedVisionModel: kind === 'vision' ? modelId : base.verifiedVisionModel,
    updatedAt: Date.now(),
  });
}

export function isReasoningModel(modelId: string): boolean {
  return REASONING_MODEL_PATTERN.test(modelId);
}

export async function fetchGroqAvailableModelIds(
  apiKey: string,
  forceRefresh = false
): Promise<string[]> {
  await ensureGroqModelStateHydrated();
  const keyHash = computeFnv1aHash(apiKey);
  const now = Date.now();

  if (
    !forceRefresh &&
    groqModelState &&
    groqModelState.keyHash === keyHash &&
    groqModelState.modelIds.length > 0 &&
    now - groqModelState.updatedAt < GROQ_MODEL_CACHE_TTL_MS
  ) {
    return groqModelState.modelIds;
  }

  if (groqModelsFetchInFlight) {
    return groqModelsFetchInFlight;
  }

  const task = (async (): Promise<string[]> => {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(API_ENDPOINTS.GROQ_MODELS, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          recordProviderAuthFailure(
            'groq',
            apiKey,
            res.status,
            `Groq HTTP ${res.status}: Invalid API key`
          );
        }
        return groqModelState?.keyHash === keyHash
          ? groqModelState.modelIds
          : [];
      }

      const body = (await res.json()) as GroqModelsListResponse;
      const discovered = (body.data ?? [])
        .filter(
          (entry) =>
            entry && typeof entry.id === 'string' && entry.active !== false
        )
        .map((entry) => String(entry.id));

      if (discovered.length > 0) {
        const prev = groqModelState?.keyHash === keyHash ? groqModelState : null;
        await persistGroqModelState({
          keyHash,
          modelIds: discovered,
          verifiedTextModel:
            prev?.verifiedTextModel &&
            discovered.includes(prev.verifiedTextModel)
              ? prev.verifiedTextModel
              : null,
          verifiedVisionModel:
            prev?.verifiedVisionModel &&
            discovered.includes(prev.verifiedVisionModel)
              ? prev.verifiedVisionModel
              : null,
          updatedAt: now,
        });
      }

      return discovered;
    } catch {
      return groqModelState?.keyHash === keyHash ? groqModelState.modelIds : [];
    } finally {
      clearTimeout(timeoutHandle);
    }
  })();

  groqModelsFetchInFlight = task;
  try {
    return await task;
  } finally {
    if (groqModelsFetchInFlight === task) {
      groqModelsFetchInFlight = null;
    }
  }
}

export async function selectGroqTextModel(
  apiKey: string,
  excludedModels: Set<string> = new Set(),
  forceRefresh = false,
  preferredFirst?: string
): Promise<string> {
  await ensureGroqModelStateHydrated();
  const keyHash = computeFnv1aHash(apiKey);

  if (preferredFirst && !excludedModels.has(preferredFirst)) {
    if (
      !groqModelState ||
      groqModelState.keyHash !== keyHash ||
      groqModelState.modelIds.length === 0 ||
      groqModelState.modelIds.includes(preferredFirst)
    ) {
      return preferredFirst;
    }
  }

  if (!forceRefresh && groqModelState && groqModelState.keyHash === keyHash) {
    if (
      groqModelState.verifiedTextModel &&
      !excludedModels.has(groqModelState.verifiedTextModel)
    ) {
      return groqModelState.verifiedTextModel;
    }

    const cachedChatCapable = groqModelState.modelIds.filter(
      (id) => !NON_CHAT_MODEL_PATTERN.test(id) && !excludedModels.has(id)
    );
    if (cachedChatCapable.length > 0) {
      for (const preferred of MODELS.GROQ_TEXT_CANDIDATES) {
        if (cachedChatCapable.includes(preferred)) {
          return preferred;
        }
      }
      return cachedChatCapable[0];
    }
  }

  if (!forceRefresh) {
    void fetchGroqAvailableModelIds(apiKey, true);
    for (const fastCandidate of MODELS.GROQ_TEXT_CANDIDATES) {
      if (!excludedModels.has(fastCandidate)) {
        return fastCandidate;
      }
    }
  }

  const available = await fetchGroqAvailableModelIds(apiKey, true);
  const chatCapable = available.filter(
    (id) => !NON_CHAT_MODEL_PATTERN.test(id) && !excludedModels.has(id)
  );

  if (chatCapable.length > 0) {
    for (const preferred of MODELS.GROQ_TEXT_CANDIDATES) {
      if (chatCapable.includes(preferred)) {
        return preferred;
      }
    }
    return chatCapable[0];
  }

  for (const fallback of MODELS.GROQ_TEXT_CANDIDATES) {
    if (!excludedModels.has(fallback)) {
      return fallback;
    }
  }

  return MODELS.GROQ_PRIMARY;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function pickDistinctGroqConsensusModels(
  apiKey: string,
  desiredCount: number,
  deepAccuracy = false
): Promise<string[]> {
  await ensureGroqModelStateHydrated();
  const keyHash = computeFnv1aHash(apiKey);
  const picked: string[] = [];
  const candidatePool = deepAccuracy
    ? MODELS.GROQ_DEEP_ACCURACY_CANDIDATES
    : MODELS.GROQ_CONSENSUS_CANDIDATES;

  if (
    groqModelState &&
    groqModelState.keyHash === keyHash &&
    groqModelState.modelIds.length > 0
  ) {
    const chatCapable = groqModelState.modelIds.filter(
      (id) => !NON_CHAT_MODEL_PATTERN.test(id)
    );
    for (const candidate of candidatePool) {
      if (chatCapable.includes(candidate) && !picked.includes(candidate)) {
        picked.push(candidate);
        if (picked.length >= desiredCount) {
          return picked;
        }
      }
    }
    for (const other of chatCapable) {
      if (!picked.includes(other) && !other.includes('8b-instant')) {
        picked.push(other);
        if (picked.length >= desiredCount) {
          return picked;
        }
      }
    }
    if (picked.length > 0) {
      return picked;
    }
  }

  void fetchGroqAvailableModelIds(apiKey, true);
  for (const candidate of candidatePool) {
    if (!picked.includes(candidate)) {
      picked.push(candidate);
      if (picked.length >= desiredCount) {
        break;
      }
    }
  }
  return picked.length > 0 ? picked : [MODELS.GROQ_PRIMARY];
}

function computeGroqModelWeight(modelId: string): number {
  const lower = modelId.toLowerCase();
  if (lower.includes('120b')) {
    return 1.58;
  }
  if (lower.includes('qwen3.8') || lower.includes('qwen3')) {
    return 1.48;
  }
  if (lower.includes('70b')) {
    return 1.44;
  }
  if (lower.includes('maverick')) {
    return 1.38;
  }
  if (lower.includes('20b')) {
    return 1.22;
  }
  if (lower.includes('8b')) {
    return 0.78;
  }
  return 1.06;
}

export async function selectGroqVisionModel(
  apiKey: string,
  excludedModels: Set<string> = new Set(),
  forceRefresh = false
): Promise<string | null> {
  await ensureGroqModelStateHydrated();
  const keyHash = computeFnv1aHash(apiKey);

  if (!forceRefresh && groqModelState && groqModelState.keyHash === keyHash) {
    if (
      groqModelState.verifiedVisionModel &&
      !excludedModels.has(groqModelState.verifiedVisionModel)
    ) {
      return groqModelState.verifiedVisionModel;
    }

    if (groqModelState.modelIds.length > 0) {
      for (const preferred of MODELS.GROQ_VISION_CANDIDATES) {
        if (
          groqModelState.modelIds.includes(preferred) &&
          !excludedModels.has(preferred)
        ) {
          return preferred;
        }
      }
      const otherCachedVision = groqModelState.modelIds.find(
        (id) =>
          VISION_CAPABLE_PATTERN.test(id) &&
          !NON_CHAT_MODEL_PATTERN.test(id) &&
          !excludedModels.has(id)
      );
      if (otherCachedVision) {
        return otherCachedVision;
      }
    }
  }

  if (!forceRefresh) {
    void fetchGroqAvailableModelIds(apiKey, true);
    for (const fastVision of MODELS.GROQ_VISION_CANDIDATES) {
      if (!excludedModels.has(fastVision)) {
        return fastVision;
      }
    }
  }

  const available = await fetchGroqAvailableModelIds(apiKey, true);
  if (available.length > 0) {
    for (const preferred of MODELS.GROQ_VISION_CANDIDATES) {
      if (available.includes(preferred) && !excludedModels.has(preferred)) {
        return preferred;
      }
    }
    const otherVision = available.find(
      (id) =>
        VISION_CAPABLE_PATTERN.test(id) &&
        !NON_CHAT_MODEL_PATTERN.test(id) &&
        !excludedModels.has(id)
    );
    return otherVision ?? null;
  }

  for (const candidate of MODELS.GROQ_VISION_CANDIDATES) {
    if (!excludedModels.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

function formatCombinedAcademicContext(
  pinnedContext: string,
  pageContext?: string
): string {
  const parts: string[] = [];
  if (pageContext && pageContext.trim().length > 0) {
    parts.push(`Course & Exam Subject: ${pageContext.trim()}`);
  }
  if (pinnedContext && pinnedContext.trim().length > 0) {
    parts.push(`Reference Lecture Notes:\n${pinnedContext.trim()}`);
  }
  return parts.join('\n\n');
}

export function buildQuizSystemInstruction(
  multiSelect: boolean,
  optionCount: number,
  pinnedContext: string,
  deepAccuracy = false,
  pageContext?: string
): string {
  const maxIndex = Math.max(1, optionCount) - 1;
  let baseDirective: string;

  if (deepAccuracy) {
    const shuffleRule =
      'CRITICAL LMS SHUFFLE RULE: Platforms like Moodle shuffle option positions, so options phrased "All of the above" / "Tất cả các câu trên đều đúng" / "Tất cả đều đúng" / "None of the above" / "Tất cả đều sai" may appear at ANY index (even [0]) and refer to all the other substantive options in the question; options like "Both A and B" / "Cả A và B đều đúng" refer to [0] (Option A) and [1] (Option B) as listed.';

    baseDirective = multiSelect
      ? [
          'You are a rigorous university professor and deterministic exam solver.',
          'Carefully analyze every word of the question and each option [0] (Option A) through [' +
            maxIndex +
            '].',
          'Check for negations (KHÔNG, NGOẠI TRỪ, SAI, CHỈ, NOT, EXCEPT, FALSE), mathematical formulas, superscripts/subscripts, units, numerical calculations, and compound options.',
          shuffleRule,
          'First write a concise 2 to 4 sentence verification evaluating the statements and computing any formula step-by-step.',
          'Then on the VERY LAST LINE output the exact tag <<ANSWER: i,j>> containing ONLY the zero-based integer indices (0 to ' +
            maxIndex +
            ') of ALL correct options separated by commas (for example: <<ANSWER: 0,2>>). Never put option letters inside <<ANSWER: ...>>, only zero-based integers.',
        ].join(' ')
      : [
          'You are a rigorous university professor and deterministic exam solver.',
          'Carefully analyze every word of the question and each option [0] (Option A) through [' +
            maxIndex +
            '].',
          'Check for negations (KHÔNG, NGOẠI TRỪ, SAI, CHỈ, NOT, EXCEPT, FALSE), mathematical formulas, superscripts/subscripts, units, numerical calculations, and compound options.',
          shuffleRule,
          'First write a concise 2 to 4 sentence verification evaluating each candidate option and computing any formula step-by-step.',
          'Then on the VERY LAST LINE output the exact tag <<ANSWER: k>> where k is the single best zero-based integer index from 0 to ' +
            maxIndex +
            ' (for example: <<ANSWER: 2>>). Never put option letters inside <<ANSWER: ...>>, only the zero-based integer.',
        ].join(' ');
  } else {
    baseDirective = multiSelect
      ? `You are an expert deterministic quiz solver. Carefully check negations (NOT/EXCEPT), exact terminology, and sequence order. Identify ALL correct options and output ONLY their zero-based integer indices (between 0 and ${maxIndex}) separated by commas with no spaces or prose, for example: 0,2`
      : `You are an expert deterministic quiz solver. Carefully check negations (NOT/EXCEPT), exact terminology, and sequence order. Identify the single best option and output ONLY its zero-based integer index (an integer from 0 to ${maxIndex}). Output strictly the digit with zero words, punctuation, or explanation.`;
  }

  const combinedContext = formatCombinedAcademicContext(
    pinnedContext,
    pageContext
  );
  if (!combinedContext) {
    return baseDirective;
  }

  return `${baseDirective}\n\n${combinedContext}`;
}

function buildQuizUserPrompt(payload: QuestionPayload): string {
  const formattedChoices = payload.options
    .map((optionText, idx) => {
      const letter = String.fromCharCode(65 + idx);
      return `[${idx}] (Option ${letter}): ${optionText}`;
    })
    .join('\n');
  return `Question:\n${payload.questionText}\n\nOptions:\n${formattedChoices}`;
}

export function extractGeminiInteractionText(
  data: GeminiInteractionResponse
): string {
  if (typeof data.output_text === 'string' && data.output_text.trim().length > 0) {
    return data.output_text.trim();
  }

  if (!Array.isArray(data.steps)) {
    return '';
  }

  const collected: string[] = [];
  for (let i = data.steps.length - 1; i >= 0; i -= 1) {
    const step = data.steps[i];
    if (step?.type === 'model_output' && Array.isArray(step.content)) {
      const stepParts: string[] = [];
      for (const item of step.content) {
        if (item?.type === 'text' && typeof item.text === 'string') {
          stepParts.push(item.text);
        }
      }
      if (stepParts.length > 0) {
        collected.unshift(stepParts.join(''));
      }
    } else if (collected.length > 0) {
      break;
    }
  }

  return collected.join('').trim();
}

export async function runGroqTextCompletionWithFallback(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal,
  preferredModel?: string,
  initialExclusions: Iterable<string> = [],
  deepAccuracy = false
): Promise<number[]> {
  const excluded = new Set<string>(initialExclusions);
  if (deepAccuracy) {
    excluded.add('llama-3.1-8b-instant');
  }
  let lastError = 'Groq inference failed';

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const modelId = await selectGroqTextModel(
      apiKey,
      excluded,
      attempt > 0,
      attempt === 0 ? preferredModel : undefined
    );
    const maxTokens = deepAccuracy
      ? isReasoningModel(modelId)
        ? 1100
        : 520
      : isReasoningModel(modelId)
        ? 420
        : 8;

    const response = await fetch(API_ENDPOINTS.GROQ_CHAT_COMPLETIONS, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as OpenAiChatResponse;
        detail = errBody.error?.message ? `: ${errBody.error.message}` : '';
      } catch {
        void 0;
      }
      lastError = `Groq HTTP ${response.status}${detail}`;

      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure('groq', apiKey, response.status, lastError);
        throw new Error(lastError);
      }

      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 429
      ) {
        excluded.add(modelId);
        if (response.status === 429 && deepAccuracy) {
          await sleepAbortable(750, signal);
        }
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const content = extractOpenAiMessageText(json.choices?.[0]?.message?.content);
    const indices = parseAnswerIndices(content, optionCount, multiSelect);

    if (indices.length > 0) {
      if (!preferredModel) {
        void recordVerifiedGroqModel(apiKey, 'text', modelId);
      }
      return indices;
    }

    excluded.add(modelId);
    lastError = `Groq (${modelId}) returned no valid answer index`;
  }

  throw new Error(lastError);
}

export async function runOpenRouterTextCompletionWithFallback(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal,
  deepAccuracy = false
): Promise<number[]> {
  const keyHash = computeFnv1aHash(apiKey);
  const candidates: string[] = [];
  if (verifiedOpenRouterModel && verifiedOpenRouterModel.keyHash === keyHash) {
    candidates.push(verifiedOpenRouterModel.modelId);
  }
  for (const model of MODELS.OPENROUTER_TEXT_CANDIDATES) {
    if (!candidates.includes(model)) {
      candidates.push(model);
    }
  }
  if (!candidates.includes('openrouter/auto')) {
    candidates.push('openrouter/auto');
  }

  let lastError = 'OpenRouter inference failed';

  for (let attempt = 0; attempt < Math.min(3, candidates.length); attempt += 1) {
    const modelId = candidates[attempt];
    const maxTokens = deepAccuracy
      ? isReasoningModel(modelId) || modelId === 'openrouter/auto'
        ? 1100
        : 520
      : isReasoningModel(modelId) || modelId === 'openrouter/auto'
        ? 420
        : 12;

    const response = await fetch(API_ENDPOINTS.OPENROUTER_CHAT_COMPLETIONS, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://kahoot.it',
        'X-Title': 'KahootHybridEngine',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as OpenAiChatResponse;
        const msg = errBody.error?.message ?? errBody.message;
        detail = msg ? `: ${msg}` : '';
      } catch {
        void 0;
      }
      lastError = `OpenRouter HTTP ${response.status}${detail}`;

      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure(
          'openrouter',
          apiKey,
          response.status,
          lastError
        );
        throw new Error(lastError);
      }

      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 402 ||
        response.status === 429 ||
        response.status === 503
      ) {
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const content = extractOpenAiMessageText(json.choices?.[0]?.message?.content);
    const indices = parseAnswerIndices(content, optionCount, multiSelect);

    if (indices.length > 0) {
      verifiedOpenRouterModel = { keyHash, modelId };
      return indices;
    }

    lastError = `OpenRouter (${modelId}) returned no valid answer index`;
  }

  throw new Error(lastError);
}

export async function runGeminiTextCompletion(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal,
  deepAccuracy = false,
  imageBase64?: string,
  imageMimeType?: string
): Promise<number[]> {
  const inputPayload =
    imageBase64 && imageBase64.length > 0
      ? [
          { type: 'text', text: userPrompt },
          {
            type: 'image',
            data: imageBase64,
            mime_type: imageMimeType ?? 'image/webp',
          },
        ]
      : userPrompt;

  const response = await fetch(API_ENDPOINTS.GEMINI_INTERACTIONS, {
    method: 'POST',
    signal,
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      'Api-Revision': GEMINI_API_REVISION,
    },
    body: JSON.stringify({
      model: MODELS.GEMINI_PRIMARY,
      store: false,
      system_instruction: systemInstruction,
      input: inputPayload,
      generation_config: {
        thinking_level: deepAccuracy ? 'high' : 'low',
        seed: 0,
      },
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = (await response.json()) as {
        error?: { message?: string };
      };
      detail = errBody.error?.message ? `: ${errBody.error.message}` : '';
    } catch {
      void 0;
    }
    const errMsg = `Gemini HTTP ${response.status}${detail}`;
    recordProviderAuthFailure('gemini', apiKey, response.status, errMsg);
    throw new Error(errMsg);
  }

  const json = (await response.json()) as GeminiInteractionResponse;
  const rawText = extractGeminiInteractionText(json);
  const indices = parseAnswerIndices(rawText, optionCount, multiSelect);

  if (indices.length === 0) {
    throw new Error('Gemini returned no valid answer index');
  }

  return indices;
}

export async function runGroqVisionCompletionWithFallback(
  systemInstruction: string,
  visionPrompt: string,
  base64: string,
  mimeType: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal
): Promise<{ indices: number[]; hostOnlyBlank?: boolean }> {
  const excluded = new Set<string>();
  let lastError = 'No Groq Vision model available on this API key.';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modelId = await selectGroqVisionModel(apiKey, excluded, attempt > 0);
    if (!modelId) {
      break;
    }
    const maxTokens = isReasoningModel(modelId) ? 640 : 380;
    const dataImageUri = 'data:' + mimeType + ';base64,' + base64;

    const response = await fetch(API_ENDPOINTS.GROQ_CHAT_COMPLETIONS, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          {
            role: 'user',
            content: [
              { type: 'text', text: visionPrompt },
              {
                type: 'image_url',
                image_url: {
                  url: dataImageUri,
                },
              },
            ],
          },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as OpenAiChatResponse;
        detail = errBody.error?.message ? `: ${errBody.error.message}` : '';
      } catch {
        void 0;
      }
      lastError = `Groq Vision HTTP ${response.status}${detail}`;

      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure('groq', apiKey, response.status, lastError);
        throw new Error(lastError);
      }

      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 429
      ) {
        excluded.add(modelId);
        if (response.status === 429) {
          await sleepAbortable(650, signal);
        }
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const rawContent = extractOpenAiMessageText(
      json.choices?.[0]?.message?.content
    );
    const cleanedUpper = rawContent
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .trim()
      .toUpperCase();

    if (cleanedUpper === 'NONE') {
      void recordVerifiedGroqModel(apiKey, 'vision', modelId);
      return { indices: [], hostOnlyBlank: true };
    }

    const indices = parseAnswerIndices(rawContent, optionCount, multiSelect);
    if (indices.length > 0) {
      void recordVerifiedGroqModel(apiKey, 'vision', modelId);
      return { indices };
    }

    excluded.add(modelId);
    lastError = `Groq Vision (${modelId}) returned no valid index`;
  }

  throw new Error(lastError);
}

export async function tryChromeBuiltInLocalAi(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  startedAt: number
): Promise<RaceResult | null> {
  try {
    const lm = globalThis.LanguageModel;
    if (!lm || typeof lm.availability !== 'function') {
      return null;
    }

    const availability = await lm.availability();
    if (availability !== 'available') {
      return null;
    }

    const session = await lm.create({
      temperature: 0,
      topK: 1,
      initialPrompts: [{ role: 'system', content: systemInstruction }],
    });

    try {
      const rawOutput = await session.prompt(userPrompt);
      const indices = parseAnswerIndices(rawOutput, optionCount, multiSelect);
      if (indices.length > 0) {
        return {
          indices,
          tier: 'tier3_local_ai',
          latencyMs: Math.round(performance.now() - startedAt),
        };
      }
      return null;
    } finally {
      session.destroy();
    }
  } catch {
    return null;
  }
}

function buildVoteKey(indices: number[], multiSelect: boolean): string {
  if (!multiSelect) {
    return String(indices[0] ?? 0);
  }
  return [...indices].sort((a, b) => a - b).join(',');
}

async function executeFastestFirstRace(
  voters: ConsensusVoterSpec[],
  startedAt: number,
  deepAccuracy = false
): Promise<RaceResult> {
  const controllers = voters.map(() => new AbortController());
  const timeoutMs = deepAccuracy
    ? DEEP_INFERENCE_TIMEOUT_MS
    : INFERENCE_TIMEOUT_MS;
  const timeoutHandle = setTimeout(() => {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }, timeoutMs);

  try {
    const tasks = voters.map(async (voter, idx): Promise<RaceResult> => {
      const indices = await voter.run(controllers[idx].signal);
      return {
        indices,
        tier: voter.tier,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    });
    return await Promise.any(tasks);
  } finally {
    clearTimeout(timeoutHandle);
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }
}

async function executeWeightedConsensusRace(
  voters: ConsensusVoterSpec[],
  multiSelect: boolean,
  startedAt: number,
  deepAccuracy = false
): Promise<RaceResult> {
  if (voters.length === 1) {
    return executeFastestFirstRace(voters, startedAt, deepAccuracy);
  }

  const controllers = voters.map(() => new AbortController());
  const timeoutMs = deepAccuracy
    ? DEEP_INFERENCE_TIMEOUT_MS
    : INFERENCE_TIMEOUT_MS;
  const windowMs = deepAccuracy
    ? DEEP_CONSENSUS_WINDOW_MS
    : CONSENSUS_DECISION_WINDOW_MS;
  const hardTimeoutHandle = setTimeout(() => {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }, timeoutMs);

  try {
    return await new Promise<RaceResult>((resolve, reject) => {
      let finished = false;
      let settledCount = 0;
      let validVoteCount = 0;
      let decisionWindowTimer: ReturnType<typeof setTimeout> | null = null;
      const errors: Error[] = [];
      const buckets = new Map<string, VoteBucket>();
      const distinctTiers = new Set(voters.map((v) => v.tier)).size;
      const settledTiers = new Set<RaceResult['tier']>();

      const getRankedBuckets = (): VoteBucket[] => {
        return Array.from(buckets.values()).sort((a, b) => {
          if (b.count !== a.count) {
            return b.count - a.count;
          }
          if (Math.abs(b.totalWeight - a.totalWeight) > 0.001) {
            return b.totalWeight - a.totalWeight;
          }
          return a.firstLatencyMs - b.firstLatencyMs;
        });
      };

      const finalizeBestBucket = (): void => {
        if (finished) {
          return;
        }
        const ranked = getRankedBuckets();
        if (ranked.length === 0) {
          return;
        }
        finished = true;
        if (decisionWindowTimer !== null) {
          clearTimeout(decisionWindowTimer);
          decisionWindowTimer = null;
        }
        const best = ranked[0];
        const isConsensus = best.count >= 2;
        const isDisputed =
          deepAccuracy &&
          (validVoteCount < 2 ||
            ranked.length > 1 ||
            best.count / Math.max(1, validVoteCount) < 0.75);
        resolve({
          indices: best.indices,
          tier: isConsensus ? 'tier3_consensus' : best.tier,
          latencyMs: Math.round(performance.now() - startedAt),
          voteSummary: isConsensus
            ? `${best.count}/${Math.max(best.count, validVoteCount)}`
            : undefined,
          disputed: isDisputed,
          competingIndices: ranked.slice(0, 3).map((b) => b.indices),
        });
      };

      voters.forEach((voter, idx) => {
        void (async () => {
          try {
            const indices = await voter.run(controllers[idx].signal);
            if (finished) {
              return;
            }
            settledCount += 1;
            validVoteCount += 1;
            settledTiers.add(voter.tier);

            const latencyNow = Math.round(performance.now() - startedAt);
            const key = buildVoteKey(indices, multiSelect);
            const existing = buckets.get(key);
            if (existing) {
              existing.count += 1;
              existing.totalWeight += voter.weight;
            } else {
              buckets.set(key, {
                indices,
                count: 1,
                totalWeight: voter.weight,
                firstLatencyMs: latencyNow,
                tier: voter.tier,
              });
            }

            const ranked = getRankedBuckets();
            const top = ranked[0];
            const runnerUpCount = ranked[1]?.count ?? 0;
            const remainingVoters = Math.max(0, voters.length - settledCount);

            if (deepAccuracy) {
              const crossProviderReady =
                distinctTiers < 2 || settledTiers.size >= 2;
              if (
                crossProviderReady &&
                top &&
                top.count >= 2 &&
                top.count > runnerUpCount + remainingVoters
              ) {
                finalizeBestBucket();
                return;
              }
            } else if (top && top.count >= 2 && top.count > runnerUpCount) {
              finalizeBestBucket();
              return;
            }

            if (settledCount >= voters.length) {
              finalizeBestBucket();
              return;
            }

            if (decisionWindowTimer === null) {
              decisionWindowTimer = setTimeout(() => {
                decisionWindowTimer = null;
                finalizeBestBucket();
              }, windowMs);
            }
          } catch (err) {
            if (finished) {
              return;
            }
            settledCount += 1;
            errors.push(
              err instanceof Error ? err : new Error(String(err))
            );
            if (settledCount >= voters.length) {
              if (buckets.size > 0) {
                finalizeBestBucket();
              } else {
                finished = true;
                if (decisionWindowTimer !== null) {
                  clearTimeout(decisionWindowTimer);
                  decisionWindowTimer = null;
                }
                reject(
                  new AggregateError(errors, 'All AI ensemble voters failed')
                );
              }
            }
          }
        })();
      });
    });
  } finally {
    clearTimeout(hardTimeoutHandle);
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }
}

export async function raceCustomPromptInference(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  settings: EngineSettings,
  startedAt = performance.now(),
  deepAccuracy = false,
  imageBase64?: string,
  imageMimeType?: string
): Promise<RaceResult> {
  const configuredProviders: Array<{
    provider: AiProviderId;
    apiKey: string;
    mutedMsg: string | null;
  }> = [];

  if (settings.groqApiKey.length > 0) {
    configuredProviders.push({
      provider: 'groq',
      apiKey: settings.groqApiKey,
      mutedMsg: isProviderKeyMuted('groq', settings.groqApiKey),
    });
  }
  if (settings.geminiApiKey.length > 0) {
    configuredProviders.push({
      provider: 'gemini',
      apiKey: settings.geminiApiKey,
      mutedMsg: isProviderKeyMuted('gemini', settings.geminiApiKey),
    });
  }
  if (settings.openRouterApiKey.length > 0) {
    configuredProviders.push({
      provider: 'openrouter',
      apiKey: settings.openRouterApiKey,
      mutedMsg: isProviderKeyMuted('openrouter', settings.openRouterApiKey),
    });
  }

  if (configuredProviders.length === 0) {
    const localOnly = await tryChromeBuiltInLocalAi(
      systemInstruction,
      userPrompt,
      optionCount,
      multiSelect,
      startedAt
    );
    if (localOnly) {
      return localOnly;
    }
    throw new Error(
      'Configure at least one API key (Groq, Gemini, or OpenRouter) in Popup.'
    );
  }

  const anyUnmuted = configuredProviders.some((entry) => !entry.mutedMsg);
  const runnableProviders = anyUnmuted
    ? configuredProviders.filter((entry) => !entry.mutedMsg)
    : configuredProviders;

  const useConsensus = deepAccuracy || settings.consensusMode !== 'fastest_first';
  const voters: ConsensusVoterSpec[] = [];

  const nonGroqCount = runnableProviders.filter(
    (entry) => entry.provider !== 'groq'
  ).length;
  const hasEmbeddedImage = Boolean(imageBase64 && imageBase64.length > 0);

  for (const entry of runnableProviders) {
    if (entry.provider === 'gemini') {
      voters.push({
        id: 'gemini-primary',
        tier: 'tier3_gemini',
        weight: deepAccuracy ? 1.75 : 1.42,
        run: (signal) =>
          runGeminiTextCompletion(
            systemInstruction,
            userPrompt,
            optionCount,
            multiSelect,
            entry.apiKey,
            signal,
            deepAccuracy,
            imageBase64,
            imageMimeType
          ),
      });
    } else if (entry.provider === 'openrouter') {
      if (!hasEmbeddedImage) {
        voters.push({
          id: 'openrouter-primary',
          tier: 'tier3_openrouter',
          weight: deepAccuracy ? 1.45 : 1.28,
          run: (signal) =>
            runOpenRouterTextCompletionWithFallback(
              systemInstruction,
              userPrompt,
              optionCount,
              multiSelect,
              entry.apiKey,
              signal,
              deepAccuracy
            ),
        });
      }
    } else if (entry.provider === 'groq') {
      if (hasEmbeddedImage) {
        voters.push({
          id: 'groq-vision-embedded',
          tier: 'tier3_groq',
          weight: 1.38,
          run: async (signal) => {
            const vRes = await runGroqVisionCompletionWithFallback(
              systemInstruction,
              userPrompt,
              imageBase64!,
              imageMimeType ?? 'image/webp',
              optionCount,
              multiSelect,
              entry.apiKey,
              signal
            );
            if (vRes.indices.length === 0) {
              throw new Error('Groq multimodal returned no valid index');
            }
            return vRes.indices;
          },
        });
      }

      if (!useConsensus) {
        voters.push({
          id: 'groq-fast',
          tier: 'tier3_groq',
          weight: 1.15,
          run: (signal) =>
            runGroqTextCompletionWithFallback(
              systemInstruction,
              userPrompt,
              optionCount,
              multiSelect,
              entry.apiKey,
              signal,
              undefined,
              [],
              deepAccuracy
            ),
        });
      } else {
        const desiredGroqVoters = deepAccuracy
          ? nonGroqCount >= 2
            ? 2
            : nonGroqCount === 1
              ? 2
              : 3
          : nonGroqCount >= 2
            ? 1
            : 2;
        const groqModels = await pickDistinctGroqConsensusModels(
          entry.apiKey,
          desiredGroqVoters,
          deepAccuracy
        );
        groqModels.forEach((assignedModel, idx) => {
          const siblingModels = groqModels.filter((_, j) => j !== idx);
          voters.push({
            id: `groq-voter-${idx}`,
            tier: 'tier3_groq',
            weight: computeGroqModelWeight(assignedModel),
            run: (signal) =>
              runGroqTextCompletionWithFallback(
                systemInstruction,
                userPrompt,
                optionCount,
                multiSelect,
                entry.apiKey,
                signal,
                assignedModel,
                siblingModels,
                deepAccuracy
              ),
          });
        });
      }
    }
  }

  try {
    if (useConsensus) {
      return await executeWeightedConsensusRace(
        voters,
        multiSelect,
        startedAt,
        deepAccuracy
      );
    }
    return await executeFastestFirstRace(voters, startedAt, deepAccuracy);
  } catch (err) {
    const localFallback = await tryChromeBuiltInLocalAi(
      systemInstruction,
      userPrompt,
      optionCount,
      multiSelect,
      startedAt
    );
    if (localFallback) {
      return localFallback;
    }

    if (err instanceof AggregateError && err.errors.length > 0) {
      const details = err.errors
        .map((item) => (item instanceof Error ? item.message : String(item)))
        .join('; ');
      throw new Error(`AI Ensemble failed: ${details}`);
    }
    throw err instanceof Error ? err : new Error('AI Ensemble failed');
  }
}

export function buildFillBlankSystemInstruction(
  blankLengthHint: number | undefined,
  pinnedContext: string,
  deepAccuracy = false,
  pageContext?: string
): string {
  const lengthRule =
    typeof blankLengthHint === 'number' && blankLengthHint > 0
      ? ` CRITICAL: The input box has exactly ${blankLengthHint} character slots, so your answer MUST be ${blankLengthHint} characters (excluding spaces if needed to fit ${blankLengthHint}).`
      : '';
  const baseDirective = deepAccuracy
    ? `You are a rigorous university professor solving a Fill-in-the-Blank / Numerical / Short-Answer exam question.${lengthRule} First verify any formula, unit conversion, or rounding requirement concisely in 2 to 3 sentences. Then on the VERY LAST LINE output <<ANSWER: exact_value>> containing ONLY the exact number, word, or concise phrase (with no surrounding quotes or units unless requested).`
    : `You are an expert deterministic quiz solver for Fill-in-the-Blank and Short-Answer questions. Output ONLY the exact missing word, number, symbol, or concise phrase that answers the question.${lengthRule} Output zero explanation, zero surrounding quotes, zero markdown, and zero trailing period.`;

  const combinedContext = formatCombinedAcademicContext(
    pinnedContext,
    pageContext
  );
  if (!combinedContext) {
    return baseDirective;
  }
  return `${baseDirective}\n\n${combinedContext}`;
}

async function runGroqFillBlankWithFallback(
  systemInstruction: string,
  userPrompt: string,
  expectedLength: number | undefined,
  apiKey: string,
  signal: AbortSignal,
  preferredModel?: string,
  initialExclusions: Iterable<string> = [],
  deepAccuracy = false
): Promise<string> {
  const excluded = new Set<string>(initialExclusions);
  if (deepAccuracy) {
    excluded.add('llama-3.1-8b-instant');
  }
  let lastError = 'Groq fill-blank inference failed';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modelId = await selectGroqTextModel(
      apiKey,
      excluded,
      attempt > 0,
      attempt === 0 ? preferredModel : undefined
    );
    const maxTokens = deepAccuracy
      ? isReasoningModel(modelId)
        ? 1100
        : 480
      : isReasoningModel(modelId)
        ? 420
        : 40;

    const response = await fetch(API_ENDPOINTS.GROQ_CHAT_COMPLETIONS, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as OpenAiChatResponse;
        detail = errBody.error?.message ? `: ${errBody.error.message}` : '';
      } catch {
        void 0;
      }
      lastError = `Groq HTTP ${response.status}${detail}`;
      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure('groq', apiKey, response.status, lastError);
        throw new Error(lastError);
      }
      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 429
      ) {
        excluded.add(modelId);
        if (response.status === 429 && deepAccuracy) {
          await sleepAbortable(750, signal);
        }
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const content = extractOpenAiMessageText(json.choices?.[0]?.message?.content);
    const answer = parseFillBlankAnswer(content, expectedLength);
    if (answer.length > 0) {
      if (!preferredModel) {
        void recordVerifiedGroqModel(apiKey, 'text', modelId);
      }
      return answer;
    }
    excluded.add(modelId);
    lastError = `Groq (${modelId}) returned empty fill-blank answer`;
  }

  throw new Error(lastError);
}

async function runOpenRouterFillBlankWithFallback(
  systemInstruction: string,
  userPrompt: string,
  expectedLength: number | undefined,
  apiKey: string,
  signal: AbortSignal,
  deepAccuracy = false
): Promise<string> {
  const keyHash = computeFnv1aHash(apiKey);
  const candidates: string[] = [];
  if (verifiedOpenRouterModel && verifiedOpenRouterModel.keyHash === keyHash) {
    candidates.push(verifiedOpenRouterModel.modelId);
  }
  for (const model of MODELS.OPENROUTER_TEXT_CANDIDATES) {
    if (!candidates.includes(model)) {
      candidates.push(model);
    }
  }
  if (!candidates.includes('openrouter/auto')) {
    candidates.push('openrouter/auto');
  }

  let lastError = 'OpenRouter fill-blank inference failed';

  for (let attempt = 0; attempt < Math.min(3, candidates.length); attempt += 1) {
    const modelId = candidates[attempt];
    const maxTokens = deepAccuracy
      ? isReasoningModel(modelId) || modelId === 'openrouter/auto'
        ? 1100
        : 480
      : isReasoningModel(modelId) || modelId === 'openrouter/auto'
        ? 420
        : 48;

    const response = await fetch(API_ENDPOINTS.OPENROUTER_CHAT_COMPLETIONS, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://wayground.com',
        'X-Title': 'KahootHybridEngine',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as OpenAiChatResponse;
        const msg = errBody.error?.message ?? errBody.message;
        detail = msg ? `: ${msg}` : '';
      } catch {
        void 0;
      }
      lastError = `OpenRouter HTTP ${response.status}${detail}`;
      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure(
          'openrouter',
          apiKey,
          response.status,
          lastError
        );
        throw new Error(lastError);
      }
      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 402 ||
        response.status === 429 ||
        response.status === 503
      ) {
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const content = extractOpenAiMessageText(json.choices?.[0]?.message?.content);
    const answer = parseFillBlankAnswer(content, expectedLength);
    if (answer.length > 0) {
      verifiedOpenRouterModel = { keyHash, modelId };
      return answer;
    }
    lastError = `OpenRouter (${modelId}) returned empty fill-blank answer`;
  }

  throw new Error(lastError);
}

async function runGeminiFillBlankCompletion(
  systemInstruction: string,
  userPrompt: string,
  expectedLength: number | undefined,
  apiKey: string,
  signal: AbortSignal,
  deepAccuracy = false,
  imageBase64?: string,
  imageMimeType?: string
): Promise<string> {
  const inputPayload =
    imageBase64 && imageBase64.length > 0
      ? [
          { type: 'text', text: userPrompt },
          {
            type: 'image',
            data: imageBase64,
            mime_type: imageMimeType ?? 'image/webp',
          },
        ]
      : userPrompt;

  const response = await fetch(API_ENDPOINTS.GEMINI_INTERACTIONS, {
    method: 'POST',
    signal,
    headers: {
      'x-goog-api-key': apiKey,
      'Content-Type': 'application/json',
      'Api-Revision': GEMINI_API_REVISION,
    },
    body: JSON.stringify({
      model: MODELS.GEMINI_PRIMARY,
      store: false,
      system_instruction: systemInstruction,
      input: inputPayload,
      generation_config: {
        thinking_level: deepAccuracy ? 'high' : 'low',
        seed: 0,
      },
    }),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const errBody = (await response.json()) as {
        error?: { message?: string };
      };
      detail = errBody.error?.message ? `: ${errBody.error.message}` : '';
    } catch {
      void 0;
    }
    const errMsg = `Gemini HTTP ${response.status}${detail}`;
    recordProviderAuthFailure('gemini', apiKey, response.status, errMsg);
    throw new Error(errMsg);
  }

  const json = (await response.json()) as GeminiInteractionResponse;
  const rawText = extractGeminiInteractionText(json);
  const answer = parseFillBlankAnswer(rawText, expectedLength);
  if (!answer) {
    throw new Error('Gemini returned empty fill-blank answer');
  }
  return answer;
}

export async function runGroqVisionFillBlankWithFallback(
  systemInstruction: string,
  visionPrompt: string,
  base64: string,
  mimeType: string,
  expectedLength: number | undefined,
  apiKey: string,
  signal: AbortSignal
): Promise<{ fillText: string; hostOnlyBlank?: boolean }> {
  const excluded = new Set<string>();
  let lastError = 'No Groq Vision model available on this API key.';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modelId = await selectGroqVisionModel(apiKey, excluded, attempt > 0);
    if (!modelId) {
      break;
    }
    const maxTokens = isReasoningModel(modelId) ? 640 : 320;
    const dataImageUri = 'data:' + mimeType + ';base64,' + base64;

    const response = await fetch(API_ENDPOINTS.GROQ_CHAT_COMPLETIONS, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          {
            role: 'user',
            content: [
              { type: 'text', text: visionPrompt },
              {
                type: 'image_url',
                image_url: { url: dataImageUri },
              },
            ],
          },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errBody = (await response.json()) as OpenAiChatResponse;
        detail = errBody.error?.message ? `: ${errBody.error.message}` : '';
      } catch {
        void 0;
      }
      lastError = `Groq Vision HTTP ${response.status}${detail}`;
      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure('groq', apiKey, response.status, lastError);
        throw new Error(lastError);
      }
      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 429
      ) {
        excluded.add(modelId);
        if (response.status === 429) {
          await sleepAbortable(650, signal);
        }
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const rawContent = extractOpenAiMessageText(
      json.choices?.[0]?.message?.content
    );
    const cleanedUpper = rawContent
      .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
      .trim()
      .toUpperCase();

    if (cleanedUpper === 'NONE') {
      void recordVerifiedGroqModel(apiKey, 'vision', modelId);
      return { fillText: '', hostOnlyBlank: true };
    }

    const answer = parseFillBlankAnswer(rawContent, expectedLength);
    if (answer.length > 0) {
      void recordVerifiedGroqModel(apiKey, 'vision', modelId);
      return { fillText: answer };
    }
    excluded.add(modelId);
    lastError = `Groq Vision (${modelId}) returned empty fill-blank answer`;
  }

  throw new Error(lastError);
}

export async function raceCustomFillBlankInference(
  systemInstruction: string,
  userPrompt: string,
  expectedLength: number | undefined,
  settings: EngineSettings,
  startedAt = performance.now(),
  deepAccuracy = false,
  imageBase64?: string,
  imageMimeType?: string
): Promise<RaceResult> {
  const configuredProviders: Array<{
    provider: AiProviderId;
    apiKey: string;
    mutedMsg: string | null;
  }> = [];

  if (settings.groqApiKey.length > 0) {
    configuredProviders.push({
      provider: 'groq',
      apiKey: settings.groqApiKey,
      mutedMsg: isProviderKeyMuted('groq', settings.groqApiKey),
    });
  }
  if (settings.geminiApiKey.length > 0) {
    configuredProviders.push({
      provider: 'gemini',
      apiKey: settings.geminiApiKey,
      mutedMsg: isProviderKeyMuted('gemini', settings.geminiApiKey),
    });
  }
  if (settings.openRouterApiKey.length > 0) {
    configuredProviders.push({
      provider: 'openrouter',
      apiKey: settings.openRouterApiKey,
      mutedMsg: isProviderKeyMuted('openrouter', settings.openRouterApiKey),
    });
  }

  const tryLocalFill = async (): Promise<RaceResult | null> => {
    try {
      const lm = globalThis.LanguageModel;
      if (!lm || typeof lm.availability !== 'function') {
        return null;
      }
      if ((await lm.availability()) !== 'available') {
        return null;
      }
      const session = await lm.create({
        temperature: 0,
        topK: 1,
        initialPrompts: [{ role: 'system', content: systemInstruction }],
      });
      try {
        const rawOut = await session.prompt(userPrompt);
        const parsed = parseFillBlankAnswer(rawOut, expectedLength);
        if (parsed) {
          return {
            indices: [],
            fillText: parsed,
            tier: 'tier3_local_ai',
            latencyMs: Math.round(performance.now() - startedAt),
          };
        }
        return null;
      } finally {
        session.destroy();
      }
    } catch {
      return null;
    }
  };

  if (configuredProviders.length === 0) {
    const localRes = await tryLocalFill();
    if (localRes) {
      return localRes;
    }
    throw new Error(
      'Configure at least one API key (Groq, Gemini, or OpenRouter) in Popup.'
    );
  }

  const anyUnmuted = configuredProviders.some((entry) => !entry.mutedMsg);
  const runnableProviders = anyUnmuted
    ? configuredProviders.filter((entry) => !entry.mutedMsg)
    : configuredProviders;
  const useConsensus = deepAccuracy || settings.consensusMode !== 'fastest_first';
  const nonGroqCount = runnableProviders.filter(
    (entry) => entry.provider !== 'groq'
  ).length;
  const hasEmbeddedImage = Boolean(imageBase64 && imageBase64.length > 0);

  interface TextVoterSpec {
    tier: RaceResult['tier'];
    weight: number;
    run: (signal: AbortSignal) => Promise<string>;
  }

  const textVoters: TextVoterSpec[] = [];

  for (const entry of runnableProviders) {
    if (entry.provider === 'gemini') {
      textVoters.push({
        tier: 'tier3_gemini',
        weight: deepAccuracy ? 1.75 : 1.42,
        run: (signal) =>
          runGeminiFillBlankCompletion(
            systemInstruction,
            userPrompt,
            expectedLength,
            entry.apiKey,
            signal,
            deepAccuracy,
            imageBase64,
            imageMimeType
          ),
      });
    } else if (entry.provider === 'openrouter') {
      if (!hasEmbeddedImage) {
        textVoters.push({
          tier: 'tier3_openrouter',
          weight: deepAccuracy ? 1.45 : 1.28,
          run: (signal) =>
            runOpenRouterFillBlankWithFallback(
              systemInstruction,
              userPrompt,
              expectedLength,
              entry.apiKey,
              signal,
              deepAccuracy
            ),
        });
      }
    } else if (entry.provider === 'groq') {
      if (hasEmbeddedImage) {
        textVoters.push({
          tier: 'tier3_groq',
          weight: 1.38,
          run: async (signal) => {
            const vRes = await runGroqVisionFillBlankWithFallback(
              systemInstruction,
              userPrompt,
              imageBase64!,
              imageMimeType ?? 'image/webp',
              expectedLength,
              entry.apiKey,
              signal
            );
            if (!vRes.fillText) {
              throw new Error('Groq multimodal returned empty fill-blank');
            }
            return vRes.fillText;
          },
        });
      }

      if (!useConsensus) {
        textVoters.push({
          tier: 'tier3_groq',
          weight: 1.15,
          run: (signal) =>
            runGroqFillBlankWithFallback(
              systemInstruction,
              userPrompt,
              expectedLength,
              entry.apiKey,
              signal,
              undefined,
              [],
              deepAccuracy
            ),
        });
      } else {
        const desiredGroq = deepAccuracy
          ? nonGroqCount >= 2
            ? 2
            : nonGroqCount === 1
              ? 2
              : 3
          : nonGroqCount >= 2
            ? 1
            : 2;
        const groqModels = await pickDistinctGroqConsensusModels(
          entry.apiKey,
          desiredGroq,
          deepAccuracy
        );
        groqModels.forEach((assignedModel, idx) => {
          const siblings = groqModels.filter((_, j) => j !== idx);
          textVoters.push({
            tier: 'tier3_groq',
            weight: computeGroqModelWeight(assignedModel),
            run: (signal) =>
              runGroqFillBlankWithFallback(
                systemInstruction,
                userPrompt,
                expectedLength,
                entry.apiKey,
                signal,
                assignedModel,
                siblings,
                deepAccuracy
              ),
          });
        });
      }
    }
  }

  const controllers = textVoters.map(() => new AbortController());
  const timeoutMs = deepAccuracy
    ? DEEP_INFERENCE_TIMEOUT_MS
    : INFERENCE_TIMEOUT_MS;
  const windowMs = deepAccuracy
    ? DEEP_CONSENSUS_WINDOW_MS
    : CONSENSUS_DECISION_WINDOW_MS;
  const hardTimeoutHandle = setTimeout(() => {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }, timeoutMs);

  try {
    if (!useConsensus || textVoters.length === 1) {
      const winner = await Promise.any(
        textVoters.map(async (voter, idx): Promise<RaceResult> => {
          const fillText = await voter.run(controllers[idx].signal);
          return {
            indices: [],
            fillText,
            tier: voter.tier,
            latencyMs: Math.round(performance.now() - startedAt),
          };
        })
      );
      return winner;
    }

    return await new Promise<RaceResult>((resolve, reject) => {
      let finished = false;
      let settledCount = 0;
      let validVotes = 0;
      let windowTimer: ReturnType<typeof setTimeout> | null = null;
      const errors: Error[] = [];
      const buckets = new Map<
        string,
        {
          fillText: string;
          count: number;
          totalWeight: number;
          firstLatencyMs: number;
          tier: RaceResult['tier'];
        }
      >();

      const rank = () =>
        Array.from(buckets.values()).sort((a, b) => {
          if (b.count !== a.count) {
            return b.count - a.count;
          }
          if (Math.abs(b.totalWeight - a.totalWeight) > 0.001) {
            return b.totalWeight - a.totalWeight;
          }
          return a.firstLatencyMs - b.firstLatencyMs;
        });

      const finalize = () => {
        if (finished) {
          return;
        }
        const ranked = rank();
        if (ranked.length === 0) {
          return;
        }
        finished = true;
        if (windowTimer !== null) {
          clearTimeout(windowTimer);
          windowTimer = null;
        }
        const best = ranked[0];
        const isConsensus = best.count >= 2;
        resolve({
          indices: [],
          fillText: best.fillText,
          tier: isConsensus ? 'tier3_consensus' : best.tier,
          latencyMs: Math.round(performance.now() - startedAt),
          voteSummary: isConsensus
            ? `${best.count}/${Math.max(best.count, validVotes)}`
            : undefined,
        });
      };

      textVoters.forEach((voter, idx) => {
        void (async () => {
          try {
            const ans = await voter.run(controllers[idx].signal);
            if (finished) {
              return;
            }
            settledCount += 1;
            validVotes += 1;
            const normKey = normalizeQuestionText(ans) || ans.toLowerCase();
            const existing = buckets.get(normKey);
            if (existing) {
              existing.count += 1;
              existing.totalWeight += voter.weight;
            } else {
              buckets.set(normKey, {
                fillText: ans,
                count: 1,
                totalWeight: voter.weight,
                firstLatencyMs: Math.round(performance.now() - startedAt),
                tier: voter.tier,
              });
            }
            const ranked = rank();
            const top = ranked[0];
            const runnerUp = ranked[1]?.count ?? 0;
            const remaining = Math.max(0, textVoters.length - settledCount);
            if (deepAccuracy) {
              if (top && top.count >= 2 && top.count > runnerUp + remaining) {
                finalize();
                return;
              }
            } else if (top && top.count >= 2 && top.count > runnerUp) {
              finalize();
              return;
            }
            if (settledCount >= textVoters.length) {
              finalize();
              return;
            }
            if (windowTimer === null) {
              windowTimer = setTimeout(() => {
                windowTimer = null;
                finalize();
              }, windowMs);
            }
          } catch (err) {
            if (finished) {
              return;
            }
            settledCount += 1;
            errors.push(err instanceof Error ? err : new Error(String(err)));
            if (settledCount >= textVoters.length) {
              if (buckets.size > 0) {
                finalize();
              } else {
                finished = true;
                if (windowTimer !== null) {
                  clearTimeout(windowTimer);
                }
                reject(new AggregateError(errors, 'All fill-blank voters failed'));
              }
            }
          }
        })();
      });
    });
  } catch (err) {
    const localRes = await tryLocalFill();
    if (localRes) {
      return localRes;
    }
    if (err instanceof AggregateError && err.errors.length > 0) {
      const details = err.errors
        .map((item) => (item instanceof Error ? item.message : String(item)))
        .join('; ');
      throw new Error(`AI Fill-Blank failed: ${details}`);
    }
    throw err instanceof Error ? err : new Error('AI Fill-Blank failed');
  } finally {
    clearTimeout(hardTimeoutHandle);
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }
}

async function runGeminiArbiterCompletion(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal,
  imageBase64?: string,
  imageMimeType?: string
): Promise<{ indices: number[]; usedProModel: boolean }> {
  const inputPayload =
    imageBase64 && imageBase64.length > 0
      ? [
          { type: 'text', text: userPrompt },
          {
            type: 'image',
            data: imageBase64,
            mime_type: imageMimeType ?? 'image/webp',
          },
        ]
      : userPrompt;

  try {
    const proRes = await fetch(API_ENDPOINTS.GEMINI_INTERACTIONS, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        'Api-Revision': GEMINI_API_REVISION,
      },
      body: JSON.stringify({
        model: MODELS.GEMINI_PRO_ARBITER,
        store: false,
        system_instruction: systemInstruction,
        input: inputPayload,
        generation_config: {
          thinking_level: 'medium',
          seed: 0,
        },
      }),
    });

    if (proRes.ok) {
      const proJson = (await proRes.json()) as GeminiInteractionResponse;
      const proText = extractGeminiInteractionText(proJson);
      const proIndices = parseAnswerIndices(proText, optionCount, multiSelect);
      if (proIndices.length > 0) {
        return { indices: proIndices, usedProModel: true };
      }
    }
  } catch {
    void 0;
  }

  const flashIndices = await runGeminiTextCompletion(
    systemInstruction,
    userPrompt,
    optionCount,
    multiSelect,
    apiKey,
    signal,
    true,
    imageBase64,
    imageMimeType
  );
  return { indices: flashIndices, usedProModel: false };
}

export async function runSurgicalArbiterVerification(
  item: {
    questionText: string;
    options: string[];
    multiSelect: boolean;
    optionCount: number;
    imageBase64?: string;
    imageMimeType?: 'image/webp' | 'image/png' | 'image/jpeg';
  },
  competingCandidates: number[][],
  pageContext: string | undefined,
  settings: EngineSettings
): Promise<RaceResult | null> {
  const startedAt = performance.now();
  const safeOptionCount = Math.max(
    2,
    item.optionCount || item.options.length || 4
  );
  const maxIndex = safeOptionCount - 1;
  const combinedContext = formatCombinedAcademicContext(
    settings.pinnedContext,
    pageContext
  );

  const flatCandidates = Array.from(
    new Set(competingCandidates.flat().filter((i) => i >= 0 && i <= maxIndex))
  );
  const disputeNote =
    flatCandidates.length >= 2
      ? `DISPUTE ALERT: An initial AI panel split between indices [${flatCandidates
          .map((i) => `${i} (Option ${String.fromCharCode(65 + i)})`)
          .join(' vs ')}]. Perform a Devil's-Advocate audit comparing every word of those candidates AND all other options to expose any subtle distractor trap.`
      : `CRITICAL AUDIT: Perform an exhaustive textbook & mathematical audit of every option before locking the final answer.`;

  const arbiterSystem = [
    'You are the Chief University Exam Arbiter resolving a high-stakes disputed question.',
    disputeNote,
    '1. Check exact textbook definitions, ceteris paribus assumptions, short-run vs long-run distinctions, signs/exponents, units, and step-by-step math.',
    '2. Check Vietnamese/English negations (KHÔNG, SAI, NGOẠI TRỪ, CHỈ, NOT, EXCEPT, FALSE).',
    '3. Remember Moodle shuffles options: "Tất cả các câu trên đều đúng" / "All of the above" / "Tất cả đều đúng" at ANY position (even [0]) refers to all the other substantive options in the question; "Cả A và B đều đúng" refers to [0] (Option A) and [1] (Option B) as displayed.',
    '4. Write a rigorous 3 to 5 sentence step-by-step proof eliminating false options, then on the VERY LAST LINE output strictly ' +
      (item.multiSelect
        ? `<<ANSWER: i,j>> with all correct zero-based indices (0 to ${maxIndex}).`
        : `<<ANSWER: k>> with the single verified zero-based index (0 to ${maxIndex}).`),
    combinedContext ? `\n${combinedContext}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  const formattedChoices = item.options
    .map((opt, idx) => `[${idx}] (Option ${String.fromCharCode(65 + idx)}): ${opt}`)
    .join('\n');
  const arbiterUserPrompt = `Question:\n${item.questionText}\n\nOptions:\n${formattedChoices}`;

  const voters: ConsensusVoterSpec[] = [];
  const hasImage = Boolean(item.imageBase64 && item.imageBase64.length > 0);

  if (
    settings.geminiApiKey.length > 0 &&
    !isProviderKeyMuted('gemini', settings.geminiApiKey)
  ) {
    voters.push({
      id: 'arbiter-gemini',
      tier: 'tier3_gemini',
      weight: 1.92,
      run: async (signal) => {
        const res = await runGeminiArbiterCompletion(
          arbiterSystem,
          arbiterUserPrompt,
          safeOptionCount,
          item.multiSelect,
          settings.geminiApiKey,
          signal,
          item.imageBase64,
          item.imageMimeType
        );
        return res.indices;
      },
    });
  }

  if (
    settings.groqApiKey.length > 0 &&
    !isProviderKeyMuted('groq', settings.groqApiKey)
  ) {
    const groqArbiterModels = await pickDistinctGroqConsensusModels(
      settings.groqApiKey,
      2,
      true
    );
    groqArbiterModels.forEach((modelId, idx) => {
      const siblings = groqArbiterModels.filter((_, j) => j !== idx);
      voters.push({
        id: `arbiter-groq-${idx}`,
        tier: 'tier3_groq',
        weight: computeGroqModelWeight(modelId),
        run: (signal) =>
          runGroqTextCompletionWithFallback(
            arbiterSystem,
            arbiterUserPrompt,
            safeOptionCount,
            item.multiSelect,
            settings.groqApiKey,
            signal,
            modelId,
            siblings,
            true
          ),
      });
    });
  }

  if (
    !hasImage &&
    settings.openRouterApiKey.length > 0 &&
    !isProviderKeyMuted('openrouter', settings.openRouterApiKey)
  ) {
    voters.push({
      id: 'arbiter-openrouter',
      tier: 'tier3_openrouter',
      weight: 1.48,
      run: (signal) =>
        runOpenRouterTextCompletionWithFallback(
          arbiterSystem,
          arbiterUserPrompt,
          safeOptionCount,
          item.multiSelect,
          settings.openRouterApiKey,
          signal,
          true
        ),
    });
  }

  if (voters.length === 0) {
    return null;
  }

  try {
    return await executeWeightedConsensusRace(
      voters,
      item.multiSelect,
      startedAt,
      true
    );
  } catch {
    return null;
  }
}

async function runSingleVoterBatchCall(
  provider: AiProviderId,
  apiKey: string,
  assignedGroqModel: string | undefined,
  groqExclusions: string[],
  systemInstruction: string,
  userPrompt: string,
  items: BatchQuestionItem[],
  signal: AbortSignal
): Promise<Map<number, number[]>> {
  const specs = items.map((it) => ({
    optionCount: Math.max(2, it.optionCount || it.options.length || 4),
    multiSelect: it.multiSelect,
  }));

  if (provider === 'gemini') {
    const response = await fetch(API_ENDPOINTS.GEMINI_INTERACTIONS, {
      method: 'POST',
      signal,
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
        'Api-Revision': GEMINI_API_REVISION,
      },
      body: JSON.stringify({
        model: MODELS.GEMINI_PRIMARY,
        store: false,
        system_instruction: systemInstruction,
        input: userPrompt,
        generation_config: {
          thinking_level: 'medium',
          seed: 0,
        },
      }),
    });

    if (!response.ok) {
      const errMsg = `Gemini Batch HTTP ${response.status}`;
      recordProviderAuthFailure('gemini', apiKey, response.status, errMsg);
      throw new Error(errMsg);
    }

    const json = (await response.json()) as GeminiInteractionResponse;
    const text = extractGeminiInteractionText(json);
    const map = parseBatchAnswerMap(text, specs);
    if (map.size === 0) {
      throw new Error('Gemini Batch returned zero parsed tags');
    }
    return map;
  }

  if (provider === 'groq') {
    const excluded = new Set<string>([
      'llama-3.1-8b-instant',
      ...groqExclusions,
    ]);
    let lastErr = 'Groq Batch failed';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const modelId = await selectGroqTextModel(
        apiKey,
        excluded,
        attempt > 0,
        attempt === 0 ? assignedGroqModel : undefined
      );
      const maxTokens = isReasoningModel(modelId) ? 2200 : 950;
      const response = await fetch(API_ENDPOINTS.GROQ_CHAT_COMPLETIONS, {
        method: 'POST',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
          max_tokens: maxTokens,
          stream: false,
        }),
      });

      if (!response.ok) {
        lastErr = `Groq Batch HTTP ${response.status}`;
        if (response.status === 401 || response.status === 403) {
          recordProviderAuthFailure('groq', apiKey, response.status, lastErr);
          throw new Error(lastErr);
        }
        excluded.add(modelId);
        if (response.status === 429) {
          await sleepAbortable(650, signal);
        }
        continue;
      }

      const json = (await response.json()) as OpenAiChatResponse;
      const content = extractOpenAiMessageText(
        json.choices?.[0]?.message?.content
      );
      const map = parseBatchAnswerMap(content, specs);
      if (map.size > 0) {
        return map;
      }
      excluded.add(modelId);
    }
    throw new Error(lastErr);
  }

  const keyHash = computeFnv1aHash(apiKey);
  const candidates: string[] = [];
  if (verifiedOpenRouterModel && verifiedOpenRouterModel.keyHash === keyHash) {
    candidates.push(verifiedOpenRouterModel.modelId);
  }
  for (const m of MODELS.OPENROUTER_TEXT_CANDIDATES) {
    if (!candidates.includes(m)) {
      candidates.push(m);
    }
  }

  let lastErr = 'OpenRouter Batch failed';
  for (let attempt = 0; attempt < Math.min(2, candidates.length); attempt += 1) {
    const modelId = candidates[attempt];
    const response = await fetch(API_ENDPOINTS.OPENROUTER_CHAT_COMPLETIONS, {
      method: 'POST',
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://kahoot.it',
        'X-Title': 'KahootHybridEngine',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [
          { role: 'system', content: systemInstruction },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 1800,
        stream: false,
      }),
    });

    if (!response.ok) {
      lastErr = `OpenRouter Batch HTTP ${response.status}`;
      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure(
          'openrouter',
          apiKey,
          response.status,
          lastErr
        );
        throw new Error(lastErr);
      }
      continue;
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const content = extractOpenAiMessageText(
      json.choices?.[0]?.message?.content
    );
    const map = parseBatchAnswerMap(content, specs);
    if (map.size > 0) {
      verifiedOpenRouterModel = { keyHash, modelId };
      return map;
    }
  }
  throw new Error(lastErr);
}

export interface BatchVoteOutcome {
  item: BatchQuestionItem;
  resolution: BatchItemResolution;
  competingCandidates: number[][];
}

export async function raceBatchChoiceInference(
  items: BatchQuestionItem[],
  pageContext: string | undefined,
  settings: EngineSettings
): Promise<BatchVoteOutcome[]> {
  if (items.length === 0) {
    return [];
  }
  const startedAt = performance.now();
  const combinedContext = formatCombinedAcademicContext(
    settings.pinnedContext,
    pageContext
  );

  const systemInstruction = [
    `You are a rigorous university professor solving a batch of ${items.length} exam questions (Q0 through Q${items.length - 1}).`,
    'For EVERY question Qi:',
    '1. Carefully check negations (KHÔNG, NGOẠI TRỪ, SAI, CHỈ, NOT, EXCEPT, FALSE), exact textbook definitions, formulas, exponents, tables, and units.',
    '2. CRITICAL LMS SHUFFLE RULE: Platforms like Moodle shuffle option positions, so "Tất cả các câu trên đều đúng" / "All of the above" / "Tất cả đều đúng" / "None of the above" at ANY index (even [0]) refers to all the other substantive options in that question; "Cả A và B đều đúng" refers to [0] (Option A) and [1] (Option B) as listed.',
    '3. Write ONE concise verification line per question, ending that line with the exact tag <<Qi: index>> (or <<Qi: i,j>> if marked MULTI-SELECT) using ONLY zero-based integer indices. Example:',
    'Q0: Brief check of formula/definitions -> <<Q0: 2>>',
    'Q1: Brief check of statements -> <<Q1: 0>>',
    combinedContext ? `\n${combinedContext}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const promptBlocks = items.map((it, localIdx) => {
    const modeTag = it.multiSelect ? 'MULTI-SELECT' : 'SINGLE-CHOICE';
    const opts = it.options
      .map(
        (opt, oIdx) =>
          `  [${oIdx}] (Option ${String.fromCharCode(65 + oIdx)}): ${opt}`
      )
      .join('\n');
    return `=== Q${localIdx} (${modeTag}) ===\n${it.questionText}\nOptions:\n${opts}`;
  });
  const userPrompt = promptBlocks.join('\n\n');

  interface BatchVoter {
    provider: AiProviderId;
    tier: Extract<
      ResolutionTier,
      'tier3_groq' | 'tier3_gemini' | 'tier3_openrouter'
    >;
    weight: number;
    run: (signal: AbortSignal) => Promise<Map<number, number[]>>;
  }

  const voters: BatchVoter[] = [];
  const hasGemini =
    settings.geminiApiKey.length > 0 &&
    !isProviderKeyMuted('gemini', settings.geminiApiKey);
  const hasOpenRouter =
    settings.openRouterApiKey.length > 0 &&
    !isProviderKeyMuted('openrouter', settings.openRouterApiKey);
  const hasGroq =
    settings.groqApiKey.length > 0 &&
    !isProviderKeyMuted('groq', settings.groqApiKey);

  if (hasGemini) {
    voters.push({
      provider: 'gemini',
      tier: 'tier3_gemini',
      weight: 1.72,
      run: (signal) =>
        runSingleVoterBatchCall(
          'gemini',
          settings.geminiApiKey,
          undefined,
          [],
          systemInstruction,
          userPrompt,
          items,
          signal
        ),
    });
  }

  if (hasGroq) {
    const nonGroq = (hasGemini ? 1 : 0) + (hasOpenRouter ? 1 : 0);
    const desiredGroq = nonGroq >= 2 ? 2 : 3;
    const groqModels = await pickDistinctGroqConsensusModels(
      settings.groqApiKey,
      desiredGroq,
      true
    );
    groqModels.forEach((modelId, idx) => {
      const siblings = groqModels.filter((_, j) => j !== idx);
      voters.push({
        provider: 'groq',
        tier: 'tier3_groq',
        weight: computeGroqModelWeight(modelId),
        run: (signal) =>
          runSingleVoterBatchCall(
            'groq',
            settings.groqApiKey,
            modelId,
            siblings,
            systemInstruction,
            userPrompt,
            items,
            signal
          ),
      });
    });
  }

  if (hasOpenRouter) {
    voters.push({
      provider: 'openrouter',
      tier: 'tier3_openrouter',
      weight: 1.44,
      run: (signal) =>
        runSingleVoterBatchCall(
          'openrouter',
          settings.openRouterApiKey,
          undefined,
          [],
          systemInstruction,
          userPrompt,
          items,
          signal
        ),
    });
  }

  if (voters.length === 0) {
    throw new Error(
      'Configure at least one valid API key (Groq, Gemini, or OpenRouter) in Popup.'
    );
  }

  const controllers = voters.map(() => new AbortController());
  const timeoutHandle = setTimeout(() => {
    controllers.forEach((c) => c.abort());
  }, DEEP_INFERENCE_TIMEOUT_MS);

  const perItemBuckets: Array<Map<string, VoteBucket>> = items.map(
    () => new Map<string, VoteBucket>()
  );
  const perItemVoterCount: number[] = items.map(() => 0);

  const distinctProviderCount = new Set(voters.map((v) => v.provider)).size;
  const settledProviders = new Set<AiProviderId>();

  try {
    await new Promise<void>((resolve) => {
      let settled = 0;
      let windowTimer: ReturnType<typeof setTimeout> | null = null;
      let done = false;

      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        if (windowTimer !== null) {
          clearTimeout(windowTimer);
          windowTimer = null;
        }
        resolve();
      };

      const allItemsClinchedMajority = (): boolean => {
        if (distinctProviderCount >= 2 && settledProviders.size < 2) {
          return false;
        }
        const remainingVoters = Math.max(0, voters.length - settled);
        for (let q = 0; q < items.length; q += 1) {
          const buckets = Array.from(perItemBuckets[q].values()).sort(
            (a, b) => b.count - a.count || b.totalWeight - a.totalWeight
          );
          const top = buckets[0];
          const second = buckets[1]?.count ?? 0;
          if (!top || top.count < 2 || top.count <= second + remainingVoters) {
            return false;
          }
        }
        return true;
      };

      voters.forEach((voter, vIdx) => {
        void (async () => {
          try {
            const answerMap = await voter.run(controllers[vIdx].signal);
            if (done) {
              return;
            }
            settled += 1;
            settledProviders.add(voter.provider);
            const nowLat = Math.round(performance.now() - startedAt);

            for (const [qIdx, indices] of answerMap.entries()) {
              if (qIdx < 0 || qIdx >= items.length || indices.length === 0) {
                continue;
              }
              perItemVoterCount[qIdx] += 1;
              const key = buildVoteKey(indices, items[qIdx].multiSelect);
              const existing = perItemBuckets[qIdx].get(key);
              if (existing) {
                existing.count += 1;
                existing.totalWeight += voter.weight;
              } else {
                perItemBuckets[qIdx].set(key, {
                  indices,
                  count: 1,
                  totalWeight: voter.weight,
                  firstLatencyMs: nowLat,
                  tier: voter.tier,
                });
              }
            }

            if (settled >= voters.length || allItemsClinchedMajority()) {
              finish();
              return;
            }

            if (
              settled >= 2 &&
              (distinctProviderCount < 2 || settledProviders.size >= 2) &&
              windowTimer === null
            ) {
              windowTimer = setTimeout(finish, 3400);
            } else if (settled >= 2 && windowTimer === null) {
              windowTimer = setTimeout(finish, 5200);
            }
          } catch {
            if (done) {
              return;
            }
            settled += 1;
            if (settled >= voters.length) {
              finish();
            }
          }
        })();
      });
    });
  } finally {
    clearTimeout(timeoutHandle);
    controllers.forEach((c) => c.abort());
  }

  const totalLatencyMs = Math.round(performance.now() - startedAt);
  const outcomes: BatchVoteOutcome[] = [];

  for (let q = 0; q < items.length; q += 1) {
    const item = items[q];
    const ranked = Array.from(perItemBuckets[q].values()).sort((a, b) => {
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      if (Math.abs(b.totalWeight - a.totalWeight) > 0.001) {
        return b.totalWeight - a.totalWeight;
      }
      return a.firstLatencyMs - b.firstLatencyMs;
    });

    const totalValid = perItemVoterCount[q];
    const top = ranked[0];

    if (!top) {
      outcomes.push({
        item,
        resolution: {
          stateHash: item.stateHash,
          questionIndex: item.questionIndex,
          indices: [],
          tier: 'tier3_groq',
          latencyMs: totalLatencyMs,
          disputed: true,
        },
        competingCandidates: [],
      });
      continue;
    }

    const isConsensus = top.count >= 2;
    const isDisputed =
      totalValid < 2 ||
      ranked.length > 1 ||
      top.count / Math.max(1, totalValid) < 0.75;

    outcomes.push({
      item,
      resolution: {
        stateHash: item.stateHash,
        questionIndex: item.questionIndex,
        indices: top.indices,
        tier: isConsensus ? 'tier3_consensus' : top.tier,
        latencyMs: totalLatencyMs,
        voteSummary: isConsensus ? `${top.count}/${totalValid}` : undefined,
        disputed: isDisputed,
      },
      competingCandidates: ranked.slice(0, 3).map((b) => b.indices),
    });
  }

  return outcomes;
}

export async function raceParallelInference(
  payload: QuestionPayload,
  settings: EngineSettings
): Promise<RaceResult> {
  const startedAt = performance.now();
  const deepAccuracy =
    Boolean(payload.deepAccuracy) || payload.platform === 'universal';

  if (payload.questionKind === 'fill_blank') {
    const systemInstruction = buildFillBlankSystemInstruction(
      payload.blankLengthHint,
      settings.pinnedContext,
      deepAccuracy,
      payload.pageContext
    );
    const userPrompt = `Question:\n${payload.questionText}`;
    return raceCustomFillBlankInference(
      systemInstruction,
      userPrompt,
      payload.blankLengthHint,
      settings,
      startedAt,
      deepAccuracy,
      payload.imageBase64,
      payload.imageMimeType
    );
  }

  const optionCount = Math.max(
    2,
    payload.optionCount || payload.options.length || 4
  );
  const systemInstruction = buildQuizSystemInstruction(
    payload.multiSelect,
    optionCount,
    settings.pinnedContext,
    deepAccuracy,
    payload.pageContext
  );
  const userPrompt = buildQuizUserPrompt(payload);

  const primaryResult = await raceCustomPromptInference(
    systemInstruction,
    userPrompt,
    optionCount,
    payload.multiSelect,
    settings,
    startedAt,
    deepAccuracy,
    payload.imageBase64,
    payload.imageMimeType
  );

  if (deepAccuracy && primaryResult.disputed) {
    const arbiterResult = await runSurgicalArbiterVerification(
      {
        questionText: payload.questionText,
        options: payload.options,
        multiSelect: payload.multiSelect,
        optionCount,
        imageBase64: payload.imageBase64,
        imageMimeType: payload.imageMimeType,
      },
      primaryResult.competingIndices ?? [primaryResult.indices],
      payload.pageContext,
      settings
    );
    if (arbiterResult && arbiterResult.indices.length > 0) {
      return {
        ...arbiterResult,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }
  }

  return primaryResult;
}

async function silentGet(
  url: string,
  headers: Record<string, string>
): Promise<void> {
  try {
    await fetch(url, { method: 'GET', headers });
  } catch {
    return;
  }
}

export async function warmupProviderConnections(
  settings: EngineSettings,
  force = false
): Promise<void> {
  const now = Date.now();
  if (!force) {
    const sessionStore = await chrome.storage.session.get(
      STORAGE_KEYS.WARMUP_TIMESTAMP
    );
    const lastWarmup = Number(sessionStore[STORAGE_KEYS.WARMUP_TIMESTAMP] ?? 0);
    if (now - lastWarmup < WARMUP_COOLDOWN_MS) {
      return;
    }
  }

  await chrome.storage.session.set({ [STORAGE_KEYS.WARMUP_TIMESTAMP]: now });

  const warmupTasks: Array<Promise<unknown>> = [];

  if (settings.groqApiKey && !isProviderKeyMuted('groq', settings.groqApiKey)) {
    warmupTasks.push(fetchGroqAvailableModelIds(settings.groqApiKey, force));
  }

  if (
    settings.geminiApiKey &&
    !isProviderKeyMuted('gemini', settings.geminiApiKey)
  ) {
    warmupTasks.push(
      silentGet(API_ENDPOINTS.GEMINI_MODEL_META, {
        'x-goog-api-key': settings.geminiApiKey,
      })
    );
  }

  if (
    settings.openRouterApiKey &&
    !isProviderKeyMuted('openrouter', settings.openRouterApiKey)
  ) {
    warmupTasks.push(
      silentGet(API_ENDPOINTS.OPENROUTER_MODELS, {
        Authorization: `Bearer ${settings.openRouterApiKey}`,
      })
    );
  }

  if (warmupTasks.length > 0) {
    await Promise.allSettled(warmupTasks);
    await updateTelemetry({ lastWarmupAt: now });
  }
}
