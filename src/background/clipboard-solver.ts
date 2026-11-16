import {
  API_ENDPOINTS,
  GEMINI_API_REVISION,
  INFERENCE_TIMEOUT_MS,
  MODELS,
} from '../shared/constants';
import { parseAnswerIndices, parseFillBlankAnswer } from '../shared/normalize';
import type {
  ClipboardExtractedPayload,
  EngineSettings,
  OffscreenClipboardRequest,
  OffscreenClipboardResponse,
  QuestionKind,
} from '../shared/types';
import {
  buildFillBlankSystemInstruction,
  buildQuizSystemInstruction,
  extractGeminiInteractionText,
  isProviderKeyMuted,
  raceCustomFillBlankInference,
  raceCustomPromptInference,
  recordProviderAuthFailure,
  runGroqVisionCompletionWithFallback,
  runGroqVisionFillBlankWithFallback,
} from './ai-racer';
import {
  lookupLearnedCache,
  lookupLearnedFillBlank,
  lookupTier1Cache,
} from './quiz-cache';
import { buildVisionOptionMappingLines } from './vision-solver';

export interface ClipboardSolveResult {
  indices: number[];
  fillText?: string;
  latencyMs: number;
}

let offscreenCreationTask: Promise<void> | null = null;
let clipboardSolveInFlight = false;

async function ensureClipboardOffscreenDocument(): Promise<void> {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (offscreenCreationTask) {
    await offscreenCreationTask;
    return;
  }

  offscreenCreationTask = chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.CLIPBOARD],
    justification:
      'Extract snipped screenshot or copied quiz text from system clipboard on user trigger.',
  });

  try {
    await offscreenCreationTask;
  } finally {
    offscreenCreationTask = null;
  }
}

export async function readSystemClipboardPayload(): Promise<ClipboardExtractedPayload> {
  await ensureClipboardOffscreenDocument();
  const request: OffscreenClipboardRequest = {
    target: 'OFFSCREEN_CLIPBOARD',
    type: 'EXTRACT_CLIPBOARD_PAYLOAD',
  };
  const response = (await chrome.runtime.sendMessage(
    request
  )) as OffscreenClipboardResponse | undefined;

  if (!response || !response.ok) {
    throw new Error(response?.error ?? 'Unable to read from system clipboard.');
  }

  return response.payload;
}

async function queryGeminiClipboardImage(
  systemInstruction: string,
  clipboardVisionPrompt: string,
  base64: string,
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg',
  safeOptionCount: number,
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
      input: [
        { type: 'text', text: clipboardVisionPrompt },
        {
          type: 'image',
          data: base64,
          mime_type: mimeType,
        },
      ],
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
    const errMsg = `Gemini Vision HTTP ${response.status}${detail}`;
    recordProviderAuthFailure('gemini', apiKey, response.status, errMsg);
    throw new Error(errMsg);
  }

  const json = await response.json();
  const rawText = extractGeminiInteractionText(json);
  const indices = parseAnswerIndices(rawText, safeOptionCount, multiSelect);

  if (indices.length === 0) {
    throw new Error(
      'Gemini Vision could not extract a valid answer index from clipboard image.'
    );
  }

  return indices;
}

async function queryGeminiClipboardImageFillBlank(
  systemInstruction: string,
  clipboardVisionPrompt: string,
  base64: string,
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg',
  expectedLength: number | undefined,
  apiKey: string,
  signal: AbortSignal
): Promise<string> {
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
      input: [
        { type: 'text', text: clipboardVisionPrompt },
        {
          type: 'image',
          data: base64,
          mime_type: mimeType,
        },
      ],
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
    const errMsg = `Gemini Vision HTTP ${response.status}${detail}`;
    recordProviderAuthFailure('gemini', apiKey, response.status, errMsg);
    throw new Error(errMsg);
  }

  const json = await response.json();
  const rawText = extractGeminiInteractionText(json);
  const answer = parseFillBlankAnswer(rawText, expectedLength);
  if (!answer) {
    throw new Error(
      'Gemini Vision could not extract a fill-blank answer from clipboard image.'
    );
  }
  return answer;
}

async function solveClipboardImage(
  base64: string,
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg',
  optionCount: number,
  multiSelect: boolean,
  settings: EngineSettings,
  startedAt: number,
  questionKind?: QuestionKind,
  blankLengthHint?: number
): Promise<ClipboardSolveResult> {
  const hasGemini = settings.geminiApiKey.length > 0;
  const hasGroq = settings.groqApiKey.length > 0;

  if (!hasGemini && !hasGroq) {
    throw new Error('Configure Groq or Gemini API key in Popup.');
  }

  const geminiAbort = new AbortController();
  const groqAbort = new AbortController();
  const timeoutHandle = setTimeout(() => {
    geminiAbort.abort();
    groqAbort.abort();
  }, INFERENCE_TIMEOUT_MS + 1800);

  try {
    const geminiMuted = hasGemini
      ? isProviderKeyMuted('gemini', settings.geminiApiKey)
      : null;
    const groqMuted = hasGroq
      ? isProviderKeyMuted('groq', settings.groqApiKey)
      : null;

    const anyUnmuted =
      (hasGemini && !geminiMuted) || (hasGroq && !groqMuted);

    const runGemini = hasGemini && (!anyUnmuted || !geminiMuted);
    const runGroq = hasGroq && (!anyUnmuted || !groqMuted);

    if (questionKind === 'fill_blank') {
      const systemInstruction = buildFillBlankSystemInstruction(
        blankLengthHint,
        settings.pinnedContext
      );
      const fillVisionPrompt = [
        'Analyze this snipped quiz question image and determine the exact Fill-in-the-Blank answer.',
        'Output ONLY the exact missing word, number, or short phrase with zero explanation.',
      ].join('\n');

      const fillTasks: Array<Promise<string>> = [];
      if (runGemini) {
        fillTasks.push(
          queryGeminiClipboardImageFillBlank(
            systemInstruction,
            fillVisionPrompt,
            base64,
            mimeType,
            blankLengthHint,
            settings.geminiApiKey,
            geminiAbort.signal
          )
        );
      }
      if (runGroq) {
        fillTasks.push(
          (async () => {
            const groqRes = await runGroqVisionFillBlankWithFallback(
              systemInstruction,
              fillVisionPrompt,
              base64,
              mimeType,
              blankLengthHint,
              settings.groqApiKey,
              groqAbort.signal
            );
            if (!groqRes.fillText) {
              throw new Error(
                'No quiz answer detected in snipped clipboard image.'
              );
            }
            return groqRes.fillText;
          })()
        );
      }

      const winningText = await Promise.any(fillTasks);
      return {
        indices: [],
        fillText: winningText,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    }

    const safeOptionCount = Math.max(2, Math.min(optionCount || 4, 12));
    const systemInstruction = buildQuizSystemInstruction(
      multiSelect,
      safeOptionCount,
      settings.pinnedContext
    );

    const mappingLines = buildVisionOptionMappingLines(safeOptionCount);

    const clipboardVisionPrompt = [
      'Analyze this snipped quiz question image and determine the correct zero-based answer index.',
      'Index mapping rules:',
      ...mappingLines,
      'If no quiz question or visual problem is visible in the image, output NONE.',
      multiSelect
        ? 'Output ONLY the comma-separated zero-based indices of all correct choices (e.g. 0,2).'
        : `Output ONLY the single zero-based integer index (0 to ${safeOptionCount - 1}) of the correct choice.`,
    ].join('\n');

    const tasks: Array<Promise<number[]>> = [];

    if (runGemini) {
      tasks.push(
        queryGeminiClipboardImage(
          systemInstruction,
          clipboardVisionPrompt,
          base64,
          mimeType,
          safeOptionCount,
          multiSelect,
          settings.geminiApiKey,
          geminiAbort.signal
        )
      );
    }

    if (runGroq) {
      tasks.push(
        (async () => {
          const groqRes = await runGroqVisionCompletionWithFallback(
            systemInstruction,
            clipboardVisionPrompt,
            base64,
            mimeType,
            safeOptionCount,
            multiSelect,
            settings.groqApiKey,
            groqAbort.signal
          );
          if (groqRes.indices.length === 0) {
            throw new Error(
              'No quiz question detected in snipped clipboard image.'
            );
          }
          return groqRes.indices;
        })()
      );
    }

    try {
      const winningIndices = await Promise.any(tasks);
      return {
        indices: winningIndices,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (err) {
      if (err instanceof AggregateError && err.errors.length > 0) {
        const msg = err.errors
          .map((item) => (item instanceof Error ? item.message : String(item)))
          .join('; ');
        throw new Error(msg);
      }
      throw err instanceof Error ? err : new Error('Clipboard Vision failed');
    }
  } finally {
    clearTimeout(timeoutHandle);
    geminiAbort.abort();
    groqAbort.abort();
  }
}

async function solveClipboardText(
  copiedText: string,
  optionCount: number,
  multiSelect: boolean,
  settings: EngineSettings,
  startedAt: number,
  questionKind?: QuestionKind,
  blankLengthHint?: number
): Promise<ClipboardSolveResult> {
  if (questionKind === 'fill_blank') {
    const learnedFill = await lookupLearnedFillBlank(copiedText);
    if (learnedFill) {
      return {
        indices: [],
        fillText: learnedFill,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
    }

    const systemInstruction = buildFillBlankSystemInstruction(
      blankLengthHint,
      settings.pinnedContext
    );
    const ensembleFill = await raceCustomFillBlankInference(
      systemInstruction,
      `Question: ${copiedText}`,
      blankLengthHint,
      settings,
      startedAt
    );
    return {
      indices: [],
      fillText: ensembleFill.fillText,
      latencyMs: ensembleFill.latencyMs,
    };
  }

  const cached = await lookupTier1Cache(copiedText, []);
  if (cached && cached.length > 0) {
    return {
      indices: cached,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  const learned = await lookupLearnedCache(copiedText, []);
  if (learned && learned.length > 0) {
    return {
      indices: learned,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }

  const safeOptionCount = Math.max(2, Math.min(optionCount || 4, 12));
  const systemInstruction = buildQuizSystemInstruction(
    multiSelect,
    safeOptionCount,
    settings.pinnedContext
  );
  const mappingLines = buildVisionOptionMappingLines(safeOptionCount);
  const textPrompt = [
    'Solve this copied quiz question and map the correct answer to a zero-based index:',
    ...mappingLines,
    '',
    copiedText,
  ].join('\n');

  const ensembleRes = await raceCustomPromptInference(
    systemInstruction,
    textPrompt,
    safeOptionCount,
    multiSelect,
    settings,
    startedAt
  );

  return {
    indices: ensembleRes.indices,
    latencyMs: ensembleRes.latencyMs,
  };
}

export async function resolveFromClipboardPayload(
  clipboard: ClipboardExtractedPayload,
  optionCount: number,
  multiSelect: boolean,
  settings: EngineSettings,
  questionKind?: QuestionKind,
  blankLengthHint?: number
): Promise<ClipboardSolveResult> {
  if (clipboard.kind === 'empty') {
    throw new Error(
      'Clipboard is empty. Use Win+Shift+S to snip the question first.'
    );
  }

  if (clipboardSolveInFlight) {
    throw new Error('Clipboard Vision request already in progress.');
  }
  clipboardSolveInFlight = true;

  const startedAt = performance.now();
  try {
    if (clipboard.kind === 'image' && clipboard.base64) {
      return await solveClipboardImage(
        clipboard.base64,
        clipboard.mimeType ?? 'image/webp',
        optionCount,
        multiSelect,
        settings,
        startedAt,
        questionKind,
        blankLengthHint
      );
    }

    if (clipboard.kind === 'text' && clipboard.text) {
      return await solveClipboardText(
        clipboard.text,
        optionCount,
        multiSelect,
        settings,
        startedAt,
        questionKind,
        blankLengthHint
      );
    }

    throw new Error('Unsupported clipboard content.');
  } finally {
    clipboardSolveInFlight = false;
  }
}

export async function resolveViaSystemClipboard(
  optionCount: number,
  multiSelect: boolean,
  settings: EngineSettings,
  questionKind?: QuestionKind,
  blankLengthHint?: number
): Promise<ClipboardSolveResult> {
  const clipboard = await readSystemClipboardPayload();
  return resolveFromClipboardPayload(
    clipboard,
    optionCount,
    multiSelect,
    settings,
    questionKind,
    blankLengthHint
  );
}
