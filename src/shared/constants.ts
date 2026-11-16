import type { EngineSettings, EngineTelemetry } from './types';

export const BRIDGE_SOURCE = 'KAHOOT_HYBRID_MAIN_BRIDGE' as const;
export const ISOLATED_BRIDGE_SOURCE = 'KAHOOT_HYBRID_ISOLATED_BRIDGE' as const;

export const STORAGE_KEYS = {
  SETTINGS: 'kahoot_hybrid_settings',
  TELEMETRY: 'kahoot_hybrid_telemetry',
  QUIZ_CACHE_SESSION: 'kahoot_hybrid_quiz_cache_session',
  QUIZ_CACHE_LOCAL: 'kahoot_hybrid_quiz_cache_local',
  LEARNED_CACHE_LOCAL: 'kahoot_hybrid_learned_cache_v2',
  GROQ_MODEL_CACHE: 'kahoot_hybrid_groq_models',
  OPENROUTER_MODEL_CACHE: 'kahoot_hybrid_openrouter_models',
  VISION_LOCK: 'kahoot_hybrid_vision_lock',
  WARMUP_TIMESTAMP: 'kahoot_hybrid_warmup_ts',
} as const;

export const DEFAULT_SETTINGS: EngineSettings = {
  enabled: true,
  quizId: '',
  groqApiKey: '',
  geminiApiKey: '',
  openRouterApiKey: '',
  consensusMode: 'consensus_vote',
  antiFocusLoss: true,
  universalHighlightEnabled: true,
  highlightStyle: 'gold',
  pinnedContext: '',
  triggerMode: 'instant_auto_click',
  targetScore: 860,
  minDelayMs: 1100,
  maxDelayMs: 2100,
};

export const DEFAULT_TELEMETRY: EngineTelemetry = {
  lastTier: null,
  lastLatencyMs: null,
  lastIndices: [],
  lastQuestionHash: null,
  cachedQuizId: '',
  cachedQuizTitle: '',
  cachedQuestionCount: 0,
  learnedQuestionCount: 0,
  lastWarmupAt: null,
  lastError: null,
};

export const SELECTORS = {
  QUESTION_TITLE:
    '[data-functional-selector="question-block-title"], [data-functional-selector="block-title"], [data-functional-selector="question-title"], [data-functional-selector="question-text"], [data-functional-selector*="block-title"], [data-functional-selector*="question-title"]',
  ANSWER_PREFIX:
    '[data-functional-selector^="answer-"], [data-functional-selector^="question-choice-"]:not([data-functional-selector^="question-choice-text-"])',
  ANSWER_BY_INDEX: (index: number) =>
    `[data-functional-selector="answer-${index}"], [data-functional-selector="question-choice-${index}"]`,
  CHOICE_TEXT_BY_INDEX: (index: number) =>
    `[data-functional-selector="question-choice-text-${index}"], [data-functional-selector="choice-text-${index}"]`,
  HOST_CHOICE_TEXT_ALL: '[data-functional-selector^="question-choice-text-"]',
  MULTI_SELECT_SUBMIT:
    '[data-functional-selector="multi-select-submit-button"]',
  QUESTION_COUNTER:
    '[data-functional-selector="question-index-counter"], [data-functional-selector="question-counter"]',
  QUESTION_TIMER:
    '[data-functional-selector="question-countdown"], [data-functional-selector*="countdown"], [data-functional-selector*="timer"]',
  POST_SUBMIT_INDICATORS:
    '[data-functional-selector="next-button"], [data-functional-selector*="question-result"], [data-functional-selector*="answer-result"], [data-functional-selector*="correct-answer"]',
} as const;

export const WAYGROUND_SELECTORS = {
  QUESTION_TITLE:
    '[data-testid="question-container-text"], [data-cy="question-container-text"], [data-highlight-block="stem"], .question-text-color, #questionText, .question-container .resizeable-text',
  QUESTION_MEDIA_IMG:
    '[data-testid="question-container"] img, [data-cy="question-container"] img, .question-media img, .question-image img, [data-testid*="question-image"] img, img[data-testid*="question"]',
  INDEXED_OPTION: (index: number) =>
    `[data-testid="option-trigger-${index}"], [data-testid="option-${index}"], [data-cy="option-${index}"]`,
  ALL_OPTION_CANDIDATES:
    '[data-testid^="option-trigger-"], [data-testid^="option-"]:not([data-testid*="container"]):not([data-testid*="options"]):not([data-testid*="text"]):not([data-testid*="label"]), [data-cy^="option-"]:not([data-cy*="container"]):not([data-cy*="options"]), .options-grid .option, .options-container .option, button.option, [role="option"]',
  SUBMIT_BUTTON:
    '[data-testid="msq-submit-button"], [data-testid="typed-submit-button"], [data-testid="save-button"], [data-testid*="submit-btn"], [data-testid*="submit-button"], [data-cy*="submit"], button.submit-button',
  BLANK_INPUTS:
    'input.typed-option-input, input.box-input, input[data-cy^="box"], [data-testid*="fib-input"], [data-testid*="blank-input"], [data-testid*="typed-input"] input, .typed-answer-wrapper input, .fib-container input',
  QUESTION_COUNTER:
    '[data-testid="question-index"], [data-cy="current-question-number"], .current-question-number, [data-testid*="question-counter"]',
  QUESTION_TIMER:
    '[data-testid*="timer"], [data-cy*="timer"], .timer-text',
  POST_SUBMIT_INDICATORS:
    '[data-testid*="result"], [data-cy*="feedback"], .answer-feedback',
} as const;

export const API_ENDPOINTS = {
  KAHOOT_REST_BASE: 'https://play.kahoot.it/rest/kahoots',
  KAHOOT_CREATE_REST_BASE: 'https://create.kahoot.it/rest/kahoots',
  KAHOOT_PLAYER_REST_BASE: 'https://kahoot.it/rest/kahoots',
  KAHOOT_CHALLENGE_PIN_BASE: 'https://kahoot.it/rest/challenges/pin',
  KAHOOT_LIVE_RESERVE_BASE: 'https://kahoot.it/reserve/session',
  GROQ_CHAT_COMPLETIONS: 'https://api.groq.com/openai/v1/chat/completions',
  GROQ_MODELS: 'https://api.groq.com/openai/v1/models',
  GEMINI_INTERACTIONS:
    'https://generativelanguage.googleapis.com/v1beta/interactions',
  GEMINI_MODEL_META:
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash',
  OPENROUTER_CHAT_COMPLETIONS:
    'https://openrouter.ai/api/v1/chat/completions',
  OPENROUTER_MODELS: 'https://openrouter.ai/api/v1/models',
} as const;

export const MODELS = {
  GROQ_PRIMARY: 'meta-llama/llama-4-scout-17b-16e-instruct',
  GROQ_TEXT_CANDIDATES: [
    'meta-llama/llama-4-maverick-17b-128e-instruct',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'openai/gpt-oss-120b',
    'llama-3.3-70b-versatile',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b',
    'llama-3.1-8b-instant',
  ],
  GROQ_CONSENSUS_CANDIDATES: [
    'meta-llama/llama-4-maverick-17b-128e-instruct',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-120b',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
  ],
  GROQ_DEEP_ACCURACY_CANDIDATES: [
    'openai/gpt-oss-120b',
    'llama-3.3-70b-versatile',
    'meta-llama/llama-4-maverick-17b-128e-instruct',
    'qwen/qwen3.8-27b',
    'openai/gpt-oss-20b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
  ],
  GROQ_VISION_CANDIDATES: [
    'meta-llama/llama-4-maverick-17b-128e-instruct',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'qwen/qwen3.8-27b',
  ],
  GEMINI_PRIMARY: 'gemini-3.8-flash',
  GEMINI_PRO_ARBITER: 'gemini-4-argon',
  OPENROUTER_TEXT_CANDIDATES: [
    'qwen/qwen3-235b-a22b:free',
    'deepseek/deepseek-chat-v3-0324:free',
    'meta-llama/llama-4-maverick:free',
    'openrouter/free',
  ],
} as const;

export const GEMINI_API_REVISION = '2026-05-20' as const;

export const HIGHLIGHT_OUTLINE_CSS = '2px solid rgba(255, 215, 0, 0.85)' as const;

export const WARMUP_COOLDOWN_MS = 22_000;
export const VISION_LOCK_TTL_MS = 4_500;
export const INFERENCE_TIMEOUT_MS = 3_600;
export const DEEP_INFERENCE_TIMEOUT_MS = 14_000;
export const CONSENSUS_DECISION_WINDOW_MS = 900;
export const DEEP_CONSENSUS_WINDOW_MS = 5_500;
export const BATCH_CHUNK_SIZE = 6;
export const MAX_PARALLEL_BATCH_CHUNKS = 5;
export const DEFAULT_QUESTION_TIMER_MS = 20_000;
export const TARGET_SCORE_MIN = 600;
export const TARGET_SCORE_MAX = 1_000;
export const VISION_MAX_DIMENSION_PX = 1280;
export const VISION_WEBP_QUALITY = 0.72;
