import {
  API_ENDPOINTS,
  CONSENSUS_DECISION_WINDOW_MS,
  GEMINI_API_REVISION,
  INFERENCE_TIMEOUT_MS,
  MODELS,
  STORAGE_KEYS,
  WARMUP_COOLDOWN_MS,
} from '../shared/constants';
import { computeFnv1aHash, parseAnswerIndices } from '../shared/normalize';
import { updateTelemetry } from '../shared/storage';
import type {
  AiProviderId,
  EngineSettings,
  QuestionPayload,
  ResolutionTier,
} from '../shared/types';

export interface RaceResult {
  indices: number[];
  tier: Extract<
    ResolutionTier,
    | 'tier3_consensus'
    | 'tier3_groq'
    | 'tier3_gemini'
    | 'tier3_openrouter'
    | 'tier3_mistral'
    | 'tier3_local_ai'
  >;
  latencyMs: number;
  voteSummary?: string;
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
  /(?:gpt-oss|qwen|qwq|deepseek|r1|openrouter\/free|magistral)/i;
const VISION_CAPABLE_PATTERN = /(?:vision|llama-4|qwen3\.8|pixtral)/i;

let groqStateHydrated = false;
let groqModelState: PersistedGroqModelState | null = null;
let groqModelsFetchInFlight: Promise<string[]> | null = null;
let verifiedOpenRouterModel: { keyHash: string; modelId: string } | null = null;
let verifiedMistralTextModel: { keyHash: string; modelId: string } | null = null;
let verifiedMistralVisionModel: { keyHash: string; modelId: string } | null =
  null;

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

async function pickDistinctGroqConsensusModels(
  apiKey: string,
  desiredCount: number
): Promise<string[]> {
  await ensureGroqModelStateHydrated();
  const keyHash = computeFnv1aHash(apiKey);
  const picked: string[] = [];

  if (
    groqModelState &&
    groqModelState.keyHash === keyHash &&
    groqModelState.modelIds.length > 0
  ) {
    const chatCapable = groqModelState.modelIds.filter(
      (id) => !NON_CHAT_MODEL_PATTERN.test(id)
    );
    for (const candidate of MODELS.GROQ_CONSENSUS_CANDIDATES) {
      if (chatCapable.includes(candidate) && !picked.includes(candidate)) {
        picked.push(candidate);
        if (picked.length >= desiredCount) {
          return picked;
        }
      }
    }
    for (const other of chatCapable) {
      if (!picked.includes(other)) {
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
  for (const candidate of MODELS.GROQ_CONSENSUS_CANDIDATES) {
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
  if (
    lower.includes('maverick') ||
    lower.includes('120b') ||
    lower.includes('70b') ||
    lower.includes('qwen3.8')
  ) {
    return 1.32;
  }
  return 1.08;
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

export function buildQuizSystemInstruction(
  multiSelect: boolean,
  optionCount: number,
  pinnedContext: string
): string {
  const maxIndex = Math.max(1, optionCount) - 1;
  const baseDirective = multiSelect
    ? `You are an expert deterministic quiz solver. Carefully check negations (NOT/EXCEPT), exact terminology, and sequence order. Identify ALL correct options and output ONLY their zero-based integer indices (between 0 and ${maxIndex}) separated by commas with no spaces or prose, for example: 0,2`
    : `You are an expert deterministic quiz solver. Carefully check negations (NOT/EXCEPT), exact terminology, and sequence order. Identify the single best option and output ONLY its zero-based integer index (an integer from 0 to ${maxIndex}). Output strictly the digit with zero words, punctuation, or explanation.`;

  const trimmedContext = pinnedContext.trim();
  if (!trimmedContext) {
    return baseDirective;
  }

  return `${baseDirective}\n\nReference Context (ground your answer in these notes first):\n${trimmedContext}`;
}

function buildQuizUserPrompt(payload: QuestionPayload): string {
  const formattedChoices = payload.options
    .map((optionText, idx) => `[${idx}] ${optionText}`)
    .join('\n');
  return `Question: ${payload.questionText}\nOptions:\n${formattedChoices}`;
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
  initialExclusions: Iterable<string> = []
): Promise<number[]> {
  const excluded = new Set<string>(initialExclusions);
  let lastError = 'Groq inference failed';

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modelId = await selectGroqTextModel(
      apiKey,
      excluded,
      attempt > 0,
      attempt === 0 ? preferredModel : undefined
    );
    const maxTokens = isReasoningModel(modelId) ? 240 : 6;

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
  signal: AbortSignal
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
    const maxTokens = isReasoningModel(modelId) || modelId === 'openrouter/auto' ? 240 : 10;

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

export async function runMistralTextCompletionWithFallback(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal
): Promise<number[]> {
  const keyHash = computeFnv1aHash(apiKey);
  const candidates: string[] = [];
  if (verifiedMistralTextModel && verifiedMistralTextModel.keyHash === keyHash) {
    candidates.push(verifiedMistralTextModel.modelId);
  }
  for (const model of MODELS.MISTRAL_TEXT_CANDIDATES) {
    if (!candidates.includes(model)) {
      candidates.push(model);
    }
  }

  let lastError = 'Mistral inference failed';

  for (let attempt = 0; attempt < Math.min(3, candidates.length); attempt += 1) {
    const modelId = candidates[attempt];

    const response = await fetch(API_ENDPOINTS.MISTRAL_CHAT_COMPLETIONS, {
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
        max_tokens: 12,
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
      lastError = `Mistral HTTP ${response.status}${detail}`;

      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure('mistral', apiKey, response.status, lastError);
        throw new Error(lastError);
      }

      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 429
      ) {
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const content = extractOpenAiMessageText(json.choices?.[0]?.message?.content);
    const indices = parseAnswerIndices(content, optionCount, multiSelect);

    if (indices.length > 0) {
      verifiedMistralTextModel = { keyHash, modelId };
      return indices;
    }

    lastError = `Mistral (${modelId}) returned no valid answer index`;
  }

  throw new Error(lastError);
}

export async function runGeminiTextCompletion(
  systemInstruction: string,
  userPrompt: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal
): Promise<number[]> {
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
        thinking_level: 'low',
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
    const maxTokens = isReasoningModel(modelId) ? 240 : 12;
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

    if (cleanedUpper.includes('NONE')) {
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

export async function runMistralVisionCompletionWithFallback(
  systemInstruction: string,
  visionPrompt: string,
  base64: string,
  mimeType: string,
  optionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal
): Promise<{ indices: number[]; hostOnlyBlank?: boolean }> {
  const keyHash = computeFnv1aHash(apiKey);
  const candidates: string[] = [];
  if (
    verifiedMistralVisionModel &&
    verifiedMistralVisionModel.keyHash === keyHash
  ) {
    candidates.push(verifiedMistralVisionModel.modelId);
  }
  for (const model of MODELS.MISTRAL_VISION_CANDIDATES) {
    if (!candidates.includes(model)) {
      candidates.push(model);
    }
  }

  let lastError = 'Mistral Vision inference failed';
  const dataImageUri = 'data:' + mimeType + ';base64,' + base64;

  for (let attempt = 0; attempt < candidates.length; attempt += 1) {
    const modelId = candidates[attempt];

    const response = await fetch(API_ENDPOINTS.MISTRAL_CHAT_COMPLETIONS, {
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
        max_tokens: 14,
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
      lastError = `Mistral Vision HTTP ${response.status}${detail}`;

      if (response.status === 401 || response.status === 403) {
        recordProviderAuthFailure('mistral', apiKey, response.status, lastError);
        throw new Error(lastError);
      }

      if (
        response.status === 404 ||
        response.status === 400 ||
        response.status === 429
      ) {
        continue;
      }
      throw new Error(lastError);
    }

    const json = (await response.json()) as OpenAiChatResponse;
    const rawContent = extractOpenAiMessageText(
      json.choices?.[0]?.message?.content
    );
    if (rawContent.toUpperCase().includes('NONE')) {
      verifiedMistralVisionModel = { keyHash, modelId };
      return { indices: [], hostOnlyBlank: true };
    }

    const indices = parseAnswerIndices(rawContent, optionCount, multiSelect);
    if (indices.length > 0) {
      verifiedMistralVisionModel = { keyHash, modelId };
      return { indices };
    }

    lastError = `Mistral Vision (${modelId}) returned no valid index`;
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
  startedAt: number
): Promise<RaceResult> {
  const controllers = voters.map(() => new AbortController());
  const timeoutHandle = setTimeout(() => {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }, INFERENCE_TIMEOUT_MS);

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
  startedAt: number
): Promise<RaceResult> {
  if (voters.length === 1) {
    return executeFastestFirstRace(voters, startedAt);
  }

  const controllers = voters.map(() => new AbortController());
  const hardTimeoutHandle = setTimeout(() => {
    for (const ctrl of controllers) {
      ctrl.abort();
    }
  }, INFERENCE_TIMEOUT_MS);

  try {
    return await new Promise<RaceResult>((resolve, reject) => {
      let finished = false;
      let settledCount = 0;
      let validVoteCount = 0;
      let decisionWindowTimer: ReturnType<typeof setTimeout> | null = null;
      const errors: Error[] = [];
      const buckets = new Map<string, VoteBucket>();

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
        resolve({
          indices: best.indices,
          tier: isConsensus ? 'tier3_consensus' : best.tier,
          latencyMs: Math.round(performance.now() - startedAt),
          voteSummary: isConsensus
            ? `${best.count}/${Math.max(best.count, validVoteCount)}`
            : undefined,
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

            if (top && top.count >= 2 && top.count > runnerUpCount) {
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
              }, CONSENSUS_DECISION_WINDOW_MS);
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
  startedAt = performance.now()
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
  if (settings.mistralApiKey.length > 0) {
    configuredProviders.push({
      provider: 'mistral',
      apiKey: settings.mistralApiKey,
      mutedMsg: isProviderKeyMuted('mistral', settings.mistralApiKey),
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
      'Configure at least one API key (Groq, Gemini, OpenRouter, or Mistral) in Popup.'
    );
  }

  const anyUnmuted = configuredProviders.some((entry) => !entry.mutedMsg);
  const runnableProviders = anyUnmuted
    ? configuredProviders.filter((entry) => !entry.mutedMsg)
    : configuredProviders;

  const useConsensus = settings.consensusMode !== 'fastest_first';
  const voters: ConsensusVoterSpec[] = [];

  const nonGroqCount = runnableProviders.filter(
    (entry) => entry.provider !== 'groq'
  ).length;

  for (const entry of runnableProviders) {
    if (entry.provider === 'gemini') {
      voters.push({
        id: 'gemini-primary',
        tier: 'tier3_gemini',
        weight: 1.42,
        run: (signal) =>
          runGeminiTextCompletion(
            systemInstruction,
            userPrompt,
            optionCount,
            multiSelect,
            entry.apiKey,
            signal
          ),
      });
    } else if (entry.provider === 'openrouter') {
      voters.push({
        id: 'openrouter-primary',
        tier: 'tier3_openrouter',
        weight: 1.28,
        run: (signal) =>
          runOpenRouterTextCompletionWithFallback(
            systemInstruction,
            userPrompt,
            optionCount,
            multiSelect,
            entry.apiKey,
            signal
          ),
      });
    } else if (entry.provider === 'mistral') {
      voters.push({
        id: 'mistral-primary',
        tier: 'tier3_mistral',
        weight: 1.26,
        run: (signal) =>
          runMistralTextCompletionWithFallback(
            systemInstruction,
            userPrompt,
            optionCount,
            multiSelect,
            entry.apiKey,
            signal
          ),
      });
    } else if (entry.provider === 'groq') {
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
              signal
            ),
        });
      } else {
        const desiredGroqVoters = nonGroqCount >= 2 ? 1 : 2;
        const groqModels = await pickDistinctGroqConsensusModels(
          entry.apiKey,
          desiredGroqVoters
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
                siblingModels
              ),
          });
        });
      }
    }
  }

  try {
    if (useConsensus) {
      return await executeWeightedConsensusRace(voters, multiSelect, startedAt);
    }
    return await executeFastestFirstRace(voters, startedAt);
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

export async function raceParallelInference(
  payload: QuestionPayload,
  settings: EngineSettings
): Promise<RaceResult> {
  const startedAt = performance.now();
  const optionCount = Math.max(
    2,
    payload.optionCount || payload.options.length || 4
  );
  const systemInstruction = buildQuizSystemInstruction(
    payload.multiSelect,
    optionCount,
    settings.pinnedContext
  );
  const userPrompt = buildQuizUserPrompt(payload);

  return raceCustomPromptInference(
    systemInstruction,
    userPrompt,
    optionCount,
    payload.multiSelect,
    settings,
    startedAt
  );
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

  if (
    settings.mistralApiKey &&
    !isProviderKeyMuted('mistral', settings.mistralApiKey)
  ) {
    warmupTasks.push(
      silentGet(API_ENDPOINTS.MISTRAL_MODELS, {
        Authorization: `Bearer ${settings.mistralApiKey}`,
      })
    );
  }

  if (warmupTasks.length > 0) {
    await Promise.allSettled(warmupTasks);
    await updateTelemetry({ lastWarmupAt: now });
  }
}
