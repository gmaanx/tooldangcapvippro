import {
  API_ENDPOINTS,
  GEMINI_API_REVISION,
  INFERENCE_TIMEOUT_MS,
  MODELS,
  VISION_MAX_DIMENSION_PX,
  VISION_WEBP_QUALITY,
} from '../shared/constants';
import { parseAnswerIndices } from '../shared/normalize';
import {
  acquireVisionCaptureLock,
  releaseVisionCaptureLock,
} from '../shared/storage';
import type { EngineSettings } from '../shared/types';
import {
  buildQuizSystemInstruction,
  extractGeminiInteractionText,
  isProviderKeyMuted,
  recordProviderAuthFailure,
  runGroqVisionCompletionWithFallback,
} from './ai-racer';

export interface VisionResolutionResult {
  indices: number[];
  latencyMs: number;
  hostOnlyBlank?: boolean;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const segments: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    segments.push(String.fromCharCode(...slice));
  }
  return btoa(segments.join(''));
}

function stripDataUrlPrefix(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',');
  return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
}

async function compressCaptureToWebp(
  jpegDataUrl: string
): Promise<{ base64: string; mimeType: 'image/webp' | 'image/jpeg' }> {
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      return {
        base64: stripDataUrlPrefix(jpegDataUrl),
        mimeType: 'image/jpeg',
      };
    }

    const sourceResponse = await fetch(jpegDataUrl);
    const sourceBlob = await sourceResponse.blob();
    const bitmap = await createImageBitmap(sourceBlob);

    const scale = Math.min(
      1,
      VISION_MAX_DIMENSION_PX / Math.max(bitmap.width, bitmap.height)
    );
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      return {
        base64: stripDataUrlPrefix(jpegDataUrl),
        mimeType: 'image/jpeg',
      };
    }

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const webpBlob = await canvas.convertToBlob({
      type: 'image/webp',
      quality: VISION_WEBP_QUALITY,
    });
    const buffer = await webpBlob.arrayBuffer();
    return {
      base64: arrayBufferToBase64(buffer),
      mimeType: 'image/webp',
    };
  } catch {
    return {
      base64: stripDataUrlPrefix(jpegDataUrl),
      mimeType: 'image/jpeg',
    };
  }
}

async function queryGeminiTabVision(
  systemInstruction: string,
  visionPrompt: string,
  base64: string,
  mimeType: 'image/webp' | 'image/jpeg',
  safeOptionCount: number,
  multiSelect: boolean,
  apiKey: string,
  signal: AbortSignal
): Promise<{ indices: number[]; hostOnlyBlank?: boolean }> {
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
        { type: 'text', text: visionPrompt },
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
  if (rawText.trim().toUpperCase().includes('NONE')) {
    return { indices: [], hostOnlyBlank: true };
  }

  const indices = parseAnswerIndices(rawText, safeOptionCount, multiSelect);
  if (indices.length === 0) {
    throw new Error('Gemini Vision could not determine a valid choice index.');
  }

  return { indices };
}

export async function resolveViaVisionCapture(
  windowId: number | undefined,
  optionCount: number,
  multiSelect: boolean,
  settings: EngineSettings
): Promise<VisionResolutionResult> {
  const hasGemini = settings.geminiApiKey.length > 0;
  const hasGroq = settings.groqApiKey.length > 0;

  if (!hasGemini && !hasGroq) {
    throw new Error(
      'Configure Groq or Gemini API key in Popup for Vision Fallback.'
    );
  }

  const lockAcquired = await acquireVisionCaptureLock();
  if (!lockAcquired) {
    throw new Error('Vision capture already in progress.');
  }

  const startedAt = performance.now();
  const geminiAbort = new AbortController();
  const groqAbort = new AbortController();
  const timeoutHandle = setTimeout(() => {
    geminiAbort.abort();
    groqAbort.abort();
  }, INFERENCE_TIMEOUT_MS + 1800);

  try {
    const targetWindowId =
      typeof windowId === 'number'
        ? windowId
        : (await chrome.windows.getLastFocused()).id;

    if (typeof targetWindowId !== 'number') {
      throw new Error('Unable to resolve target browser window for capture.');
    }

    const rawCaptureUrl = await chrome.tabs.captureVisibleTab(targetWindowId, {
      format: 'jpeg',
      quality: 82,
    });

    const compressed = await compressCaptureToWebp(rawCaptureUrl);
    const safeOptionCount = Math.max(2, Math.min(optionCount || 4, 4));
    const systemInstruction = buildQuizSystemInstruction(
      multiSelect,
      safeOptionCount,
      settings.pinnedContext
    );

    const mappingLines =
      safeOptionCount === 2
        ? [
            '0 = Left / Top-Left (Blue / Diamond / True)',
            '1 = Right / Top-Right (Red / Triangle / False)',
          ]
        : [
            '0 = Top-Left (Red / Triangle)',
            '1 = Top-Right (Blue / Diamond)',
            '2 = Bottom-Left (Yellow / Circle)',
            '3 = Bottom-Right (Green / Square)',
          ];

    const visionPrompt = [
      'Inspect this Kahoot quiz screen.',
      'Kahoot answer button index mapping:',
      ...mappingLines,
      'If no question text or visual puzzle is visible anywhere in the image (only blank colored shapes), output NONE.',
      multiSelect
        ? 'Return ONLY the comma-separated zero-based indices of all correct choices.'
        : `Return ONLY the single zero-based integer index (0 to ${safeOptionCount - 1}) of the correct choice.`,
    ].join('\n');

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

    const tasks: Array<Promise<{ indices: number[]; hostOnlyBlank?: boolean }>> =
      [];

    if (runGemini) {
      tasks.push(
        queryGeminiTabVision(
          systemInstruction,
          visionPrompt,
          compressed.base64,
          compressed.mimeType,
          safeOptionCount,
          multiSelect,
          settings.geminiApiKey,
          geminiAbort.signal
        )
      );
    }

    if (runGroq) {
      tasks.push(
        runGroqVisionCompletionWithFallback(
          systemInstruction,
          visionPrompt,
          compressed.base64,
          compressed.mimeType,
          safeOptionCount,
          multiSelect,
          settings.groqApiKey,
          groqAbort.signal
        )
      );
    }

    try {
      const winner = await Promise.any(tasks);
      return {
        indices: winner.indices,
        latencyMs: Math.round(performance.now() - startedAt),
        hostOnlyBlank: winner.hostOnlyBlank,
      };
    } catch (err) {
      if (err instanceof AggregateError && err.errors.length > 0) {
        const msg = err.errors
          .map((item) => (item instanceof Error ? item.message : String(item)))
          .join('; ');
        throw new Error(msg);
      }
      throw err instanceof Error ? err : new Error('Vision capture failed');
    }
  } finally {
    clearTimeout(timeoutHandle);
    geminiAbort.abort();
    groqAbort.abort();
    await releaseVisionCaptureLock();
  }
}
