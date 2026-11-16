export type TriggerMode =
  | 'highlight_only'
  | 'instant_auto_click'
  | 'target_score'
  | 'smart_human_jitter';

export type ConsensusMode = 'consensus_vote' | 'fastest_first';

export type AiProviderId = 'groq' | 'gemini' | 'openrouter';

export type QuizPlatform = 'kahoot' | 'wayground' | 'universal';

export type HighlightStyle = 'gold' | 'stealth';

export type QuestionKind = 'choice' | 'fill_blank';

export type ResolutionTier =
  | 'tier1_cache'
  | 'tier1_learned'
  | 'tier3_consensus'
  | 'tier3_groq'
  | 'tier3_gemini'
  | 'tier3_openrouter'
  | 'tier3_local_ai'
  | 'tier4_vision'
  | 'tier4_clipboard';

export interface EngineSettings {
  enabled: boolean;
  quizId: string;
  groqApiKey: string;
  geminiApiKey: string;
  openRouterApiKey: string;
  consensusMode: ConsensusMode;
  antiFocusLoss: boolean;
  universalHighlightEnabled: boolean;
  highlightStyle: HighlightStyle;
  pinnedContext: string;
  triggerMode: TriggerMode;
  targetScore: number;
  minDelayMs: number;
  maxDelayMs: number;
}

export interface WsQuestionSignal {
  questionIndex: number;
  questionText: string;
  options: string[];
  multiSelect: boolean;
  optionCount: number;
  hasQuestionText: boolean;
  timeAvailableMs?: number;
}

export interface QuestionPayload {
  stateHash: string;
  questionIndex: number;
  questionText: string;
  options: string[];
  multiSelect: boolean;
  optionCount: number;
  source: 'websocket' | 'dom';
  platform?: QuizPlatform;
  questionKind?: QuestionKind;
  blankLengthHint?: number;
  hasQuestionImage?: boolean;
  deepAccuracy?: boolean;
  forceRefresh?: boolean;
  imageBase64?: string;
  imageMimeType?: 'image/webp' | 'image/png' | 'image/jpeg';
}

export interface AnswerResolution {
  stateHash: string;
  questionIndex: number;
  indices: number[];
  fillText?: string;
  questionKind?: QuestionKind;
  tier: ResolutionTier;
  latencyMs: number;
  timestamp: number;
  multiSelect?: boolean;
  triggerMode?: TriggerMode;
  highlightStyle?: HighlightStyle;
  targetScore?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  voteSummary?: string;
}

export interface SerializedQuizCache {
  quizId: string;
  title: string;
  questionCount: number;
  indexEntries: Array<[string, number[]]>;
  choiceTextEntries: Array<[string, string[]]>;
  fetchedAt: number;
}

export interface LearnedQuestionEntry {
  choiceTexts: string[];
  indices: number[];
  fillText?: string;
  verified: boolean;
  updatedAt: number;
}

export interface SerializedLearnedCache {
  entries: Array<[string, LearnedQuestionEntry]>;
}

export interface EngineTelemetry {
  lastTier: ResolutionTier | null;
  lastLatencyMs: number | null;
  lastIndices: number[];
  lastQuestionHash: string | null;
  cachedQuizId: string;
  cachedQuizTitle: string;
  cachedQuestionCount: number;
  learnedQuestionCount?: number;
  lastWarmupAt: number | null;
  lastError: string | null;
}

export interface MainWorldQuizIdEnvelope {
  source: 'KAHOOT_HYBRID_MAIN_BRIDGE';
  type: 'QUIZ_ID_DETECTED';
  quizId: string;
}

export interface MainWorldQuizPayloadEnvelope {
  source: 'KAHOOT_HYBRID_MAIN_BRIDGE';
  type: 'QUIZ_PAYLOAD_CAPTURED';
  quizId: string;
  payload: KahootRestPayload;
}

export interface MainWorldQuestionEnvelope {
  source: 'KAHOOT_HYBRID_MAIN_BRIDGE';
  type: 'WS_QUESTION_EVENT';
  payload: WsQuestionSignal;
}

export interface MainWorldVerifiedAnswerEnvelope {
  source: 'KAHOOT_HYBRID_MAIN_BRIDGE';
  type: 'VERIFIED_ANSWER_REVEALED';
  correctChoices: number[];
}

export type MainWorldBridgeEnvelope =
  | MainWorldQuizIdEnvelope
  | MainWorldQuizPayloadEnvelope
  | MainWorldQuestionEnvelope
  | MainWorldVerifiedAnswerEnvelope;

export interface IsolatedToMainClickEnvelope {
  source: 'KAHOOT_HYBRID_ISOLATED_BRIDGE';
  type: 'EXEC_MAIN_WORLD_CLICK';
  indices: number[];
  submitMultiSelect?: boolean;
  fillText?: string;
  autoSubmit?: boolean;
}

export interface ClipboardExtractedPayload {
  kind: 'image' | 'text' | 'empty';
  base64?: string;
  mimeType?: 'image/webp' | 'image/png' | 'image/jpeg';
  text?: string;
}

export interface OffscreenClipboardRequest {
  target: 'OFFSCREEN_CLIPBOARD';
  type: 'EXTRACT_CLIPBOARD_PAYLOAD';
}

export interface OffscreenClipboardResponse {
  ok: boolean;
  payload: ClipboardExtractedPayload;
  error?: string;
}

export type RuntimeRequestMessage =
  | {
      type: 'RESOLVE_QUESTION';
      payload: QuestionPayload;
    }
  | {
      type: 'BROADCAST_HOST_QUESTION';
      payload: QuestionPayload;
    }
  | {
      type: 'QUERY_HOST_BROADCAST';
    }
  | {
      type: 'EXEC_DIRECT_MAIN_CLICK';
      indices: number[];
      multiSelect: boolean;
      submitOnly?: boolean;
      useMouseEvents?: boolean;
    }
  | {
      type: 'EXEC_DIRECT_TEXT_FILL';
      fillText: string;
      autoSubmit: boolean;
    }
  | {
      type: 'LEARN_VERIFIED_ANSWER';
      questionText: string;
      options: string[];
      indices: number[];
      fillText?: string;
    }
  | {
      type: 'TRIGGER_VISION_FALLBACK';
      stateHash: string;
      questionIndex: number;
      optionCount: number;
      multiSelect: boolean;
      questionKind?: QuestionKind;
      blankLengthHint?: number;
    }
  | {
      type: 'TRIGGER_CLIPBOARD_VISION';
      stateHash: string;
      questionIndex: number;
      optionCount: number;
      multiSelect: boolean;
      questionKind?: QuestionKind;
      blankLengthHint?: number;
    }
  | {
      type: 'RESOLVE_DIRECT_CLIPBOARD_PAYLOAD';
      stateHash: string;
      questionIndex: number;
      optionCount: number;
      multiSelect: boolean;
      questionKind?: QuestionKind;
      blankLengthHint?: number;
      clipboard: ClipboardExtractedPayload;
    }
  | {
      type: 'PREFETCH_QUIZ_CACHE';
      quizIdInput: string;
      openLivePinTab?: boolean;
    }
  | {
      type: 'INGEST_QUIZ_PAYLOAD';
      quizId: string;
      payload: KahootRestPayload;
    }
  | {
      type: 'CLEAR_QUIZ_CACHE';
    }
  | {
      type: 'WARMUP_CONNECTIONS';
    }
  | {
      type: 'QUIZ_ID_DETECTED';
      quizId: string;
    }
  | {
      type: 'TRIGGER_UNIVERSAL_SCAN';
      tabId?: number;
    }
  | {
      type: 'GET_ENGINE_STATUS';
    };

export type ContentPushMessage =
  | {
      type: 'PING_CONTENT_ENGINE';
    }
  | {
      type: 'SCAN_UNIVERSAL_PAGE';
      force: boolean;
    }
  | {
      type: 'APPLY_RESOLVED_ANSWER';
      resolution: AnswerResolution;
    }
  | {
      type: 'CLIPBOARD_STATUS_TOAST';
      message: string;
      isError?: boolean;
    };

export interface RuntimeScanResponse {
  ok: boolean;
  detectedCount: number;
  solvedCount: number;
  error?: string;
}

export interface RuntimeResolveResponse {
  ok: boolean;
  resolution?: AnswerResolution;
  hostOnlyBlank?: boolean;
  error?: string;
}

export interface RuntimeCacheResponse {
  ok: boolean;
  livePinOnly?: boolean;
  joinedTab?: boolean;
  quizId?: string;
  title?: string;
  questionCount?: number;
  message?: string;
  error?: string;
}

export interface KahootChallengePinPayload {
  kahoot?: KahootRestPayload;
  challenge?: {
    quizId?: string;
    kahootId?: string;
    title?: string;
  };
}

export interface RuntimeClickResponse {
  ok: boolean;
  error?: string;
  canceledByUser?: boolean;
}

export interface RuntimeStatusResponse {
  ok: boolean;
  settings: EngineSettings;
  telemetry: EngineTelemetry;
}

export interface KahootRestChoice {
  answer?: string;
  correct?: boolean;
}

export interface KahootRestQuestion {
  type?: string;
  question?: string;
  title?: string;
  choices?: KahootRestChoice[];
}

export interface KahootRestPayload {
  uuid?: string;
  title?: string;
  questions?: KahootRestQuestion[];
}
