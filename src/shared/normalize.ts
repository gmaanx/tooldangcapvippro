const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const HTML_ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/gi, (entity) => {
      return HTML_ENTITY_MAP[entity.toLowerCase()] ?? entity;
    })
    .replace(/&#(\d+);/g, (_match, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

export function normalizeQuestionText(raw: string): string {
  if (!raw) {
    return '';
  }
  const withoutTags = raw.replace(/<[^>]*>/g, ' ');
  const decoded = decodeHtmlEntities(withoutTags);
  return decoded
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractUuid(input: string): string | null {
  if (!input) {
    return null;
  }
  const match = input.match(UUID_PATTERN);
  return match ? match[0].toLowerCase() : null;
}

export function isWaygroundHostname(hostname: string): boolean {
  const lower = (hostname || '').toLowerCase();
  return (
    lower === 'wayground.com' ||
    lower.endsWith('.wayground.com') ||
    lower === 'quizizz.com' ||
    lower.endsWith('.quizizz.com') ||
    lower === 'joinmyquiz.com' ||
    lower.endsWith('.joinmyquiz.com')
  );
}

export function isKahootHostname(hostname: string): boolean {
  const lower = (hostname || '').toLowerCase();
  return (
    lower === 'kahoot.it' ||
    lower === 'play.kahoot.it' ||
    lower === 'create.kahoot.it'
  );
}

export function extractGamePin(input: string): string | null {
  if (!input || extractUuid(input)) {
    return null;
  }
  const trimmed = input.trim();
  const challengePinMatch = trimmed.match(
    /(?:\/challenge\/|[?&](?:pin|gc)=)(\d{5,10})\b/i
  );
  if (challengePinMatch) {
    return challengePinMatch[1];
  }
  const compactDigits = trimmed.replace(/[\s-]+/g, '');
  if (/^\d{5,10}$/.test(compactDigits)) {
    return compactDigits;
  }
  return null;
}

export function computeFnv1aHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function buildContentSignature(
  questionText: string,
  options: string[]
): string {
  const normQuestion = normalizeQuestionText(questionText);
  const normOptions = options.map((opt) => normalizeQuestionText(opt)).join('|');
  return computeFnv1aHash(`${normQuestion}::${normOptions}`);
}

export function buildQuestionStateHash(
  questionIndex: number,
  questionText: string,
  options: string[],
  mode: 'text' | 'vision'
): string {
  const normQuestion = normalizeQuestionText(questionText);
  const normOptions = options.map((opt) => normalizeQuestionText(opt)).join('|');
  return computeFnv1aHash(
    `${mode}::${questionIndex}::${normQuestion}::${normOptions}`
  );
}

export function stripLeadingOptionPrefix(raw: string): string {
  if (!raw) {
    return '';
  }
  return raw
    .replace(/^\s*(?:\([A-La-l]\)\s+|[A-La-l][.)]\s+)/, '')
    .trim();
}

function collectBoundedIndicesFromTokens(
  tokens: Iterable<string>,
  upperBound: number,
  multiSelect: boolean,
  allowLetterFallback = false
): number[] {
  const uniqueValid: number[] = [];
  for (const rawToken of tokens) {
    const trimmed = rawToken.trim();
    if (!trimmed) {
      continue;
    }
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number.parseInt(trimmed, 10);
      if (
        Number.isInteger(parsed) &&
        parsed >= 0 &&
        parsed <= upperBound &&
        !uniqueValid.includes(parsed)
      ) {
        uniqueValid.push(parsed);
        if (!multiSelect) {
          return uniqueValid;
        }
      }
      continue;
    }
    if (allowLetterFallback && /^[A-La-l]$/.test(trimmed)) {
      const letterIdx = trimmed.toUpperCase().charCodeAt(0) - 65;
      if (
        letterIdx >= 0 &&
        letterIdx <= upperBound &&
        !uniqueValid.includes(letterIdx)
      ) {
        uniqueValid.push(letterIdx);
        if (!multiSelect) {
          return uniqueValid;
        }
      }
    }
  }
  return uniqueValid;
}

export function parseAnswerIndices(
  rawOutput: string,
  optionCount = 4,
  multiSelect = false
): number[] {
  if (!rawOutput) {
    return [];
  }
  const upperBound = Math.max(1, Math.min(optionCount, 12)) - 1;
  const withoutClosedThink = rawOutput.replace(
    /<think>[\s\S]*?<\/think>/gi,
    ' '
  );

  const tagPattern = /<<\s*(?:ANSWER|INDEX)\s*:\s*([^>]+?)>>/gi;
  const tagMatches = Array.from(withoutClosedThink.matchAll(tagPattern));
  if (tagMatches.length > 0) {
    const lastPayload = tagMatches[tagMatches.length - 1][1] ?? '';
    const rawTokens = lastPayload.match(/\b(?:1[01]|[0-9]|[A-La-l])\b/g) ?? [];
    const fromTag = collectBoundedIndicesFromTokens(
      rawTokens,
      upperBound,
      multiSelect,
      true
    );
    if (fromTag.length > 0) {
      return fromTag;
    }
  }

  const strippedThink = withoutClosedThink
    .replace(/<think>[\s\S]*$/gi, ' ')
    .trim();
  if (!strippedThink) {
    return [];
  }

  const labeledPattern =
    /(?:final\s+answer|correct\s+(?:index|indices|option|options|answer)|answer|đáp\s+án(?:\s+đúng)?)\s*(?:is|là|:|=)\s*\[?\s*((?:(?:1[01]|[0-9])(?:\s*,\s*(?:1[01]|[0-9]))*))\s*\]?/gi;
  const labeledMatches = Array.from(strippedThink.matchAll(labeledPattern));
  if (labeledMatches.length > 0) {
    const lastCapture = labeledMatches[labeledMatches.length - 1][1] ?? '';
    const tokens = lastCapture.match(/\b(?:1[01]|[0-9])\b/g) ?? [];
    const fromLabeled = collectBoundedIndicesFromTokens(
      tokens,
      upperBound,
      multiSelect,
      false
    );
    if (fromLabeled.length > 0) {
      return fromLabeled;
    }
  }

  if (
    strippedThink.length <= 20 &&
    /^[\s\[\]().,0-9]+$/.test(strippedThink)
  ) {
    const compactTokens = strippedThink.match(/\b(?:1[01]|[0-9])\b/g) ?? [];
    return collectBoundedIndicesFromTokens(
      compactTokens,
      upperBound,
      multiSelect,
      false
    );
  }

  const nonEmptyLines = strippedThink
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const tailLine = nonEmptyLines[nonEmptyLines.length - 1] ?? '';
  const tailTokens = tailLine.match(/\b(?:1[01]|[0-9])\b/g) ?? [];
  if (tailTokens.length > 0) {
    if (!multiSelect) {
      const lastToken = tailTokens[tailTokens.length - 1];
      return collectBoundedIndicesFromTokens(
        [lastToken],
        upperBound,
        false,
        false
      );
    }
    if (tailLine.length <= 36) {
      return collectBoundedIndicesFromTokens(
        tailTokens,
        upperBound,
        true,
        false
      );
    }
  }

  return [];
}

export function parseFillBlankAnswer(
  rawOutput: string,
  expectedLength?: number
): string {
  if (!rawOutput) {
    return '';
  }
  const withoutClosedThink = rawOutput.replace(
    /<think>[\s\S]*?<\/think>/gi,
    ' '
  );
  const tagMatches = Array.from(
    withoutClosedThink.matchAll(/<<\s*ANSWER\s*:\s*([^>]+?)>>/gi)
  );
  if (tagMatches.length > 0) {
    const tagged = (tagMatches[tagMatches.length - 1][1] ?? '')
      .replace(/^["'`«“]+|["'`»”]+$/g, '')
      .trim();
    if (tagged.length > 0 && !/^none$/i.test(tagged)) {
      if (
        typeof expectedLength === 'number' &&
        expectedLength > 0 &&
        tagged.length !== expectedLength
      ) {
        const compact = tagged.replace(/\s+/g, '');
        if (compact.length === expectedLength) {
          return compact;
        }
      }
      return tagged;
    }
  }

  let cleaned = withoutClosedThink
    .replace(/<think>[\s\S]*$/gi, ' ')
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '')
    )
    .trim();

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^none$/i.test(line));

  if (lines.length === 0) {
    return '';
  }

  let candidate = lines[lines.length - 1]
    .replace(/^(?:final\s+answer|the\s+answer\s+is|answer|output|result)\s*[:=-]\s*/i, '')
    .replace(/^["'`«“]+|["'`»”]+$/g, '')
    .trim();

  if (candidate.endsWith('.') && !/\b(?:e\.g|i\.e|mr|dr|ms|st|inc|ltd)\.$/i.test(candidate)) {
    candidate = candidate.slice(0, -1).trim();
  }

  if (
    typeof expectedLength === 'number' &&
    expectedLength > 0 &&
    candidate.length !== expectedLength
  ) {
    const compact = candidate.replace(/\s+/g, '');
    if (compact.length === expectedLength) {
      return compact;
    }
  }

  return candidate;
}

const STANDARD_KAHOOT_TIMERS_SEC = [5, 10, 20, 30, 45, 60, 90, 120, 180, 240];

export function snapCountdownSecondsToTimerMs(observedSeconds: number): number {
  if (!Number.isFinite(observedSeconds) || observedSeconds <= 0) {
    return 20_000;
  }
  for (const bucket of STANDARD_KAHOOT_TIMERS_SEC) {
    if (observedSeconds <= bucket && bucket - observedSeconds <= 2) {
      return bucket * 1000;
    }
  }
  return Math.min(240_000, Math.max(5_000, Math.round(observedSeconds * 1000)));
}

export function computeTargetScoreDelayMs(
  targetScore: number,
  questionTimerMs = 20_000,
  elapsedMs = 0,
  jitterPoints?: number
): number {
  const clampedTarget = Math.min(1000, Math.max(550, Math.round(targetScore)));
  if (clampedTarget >= 990) {
    return 0;
  }

  const safeTimerMs = Math.min(
    240_000,
    Math.max(
      5_000,
      Number.isFinite(questionTimerMs) && questionTimerMs > 0
        ? questionTimerMs
        : 20_000
    )
  );

  const sampledJitter =
    typeof jitterPoints === 'number' && Number.isFinite(jitterPoints)
      ? jitterPoints
      : (Math.random() * 2 - 1) * 25;

  const effectivePoints = Math.min(
    985,
    Math.max(540, clampedTarget + sampledJitter)
  );
  const rawTargetTimeMs = safeTimerMs * 2 * (1 - effectivePoints / 1000);
  const safeTargetTimeMs = Math.min(rawTargetTimeMs, safeTimerMs * 0.82);
  const safeElapsedMs = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);

  return Math.round(Math.max(0, safeTargetTimeMs - safeElapsedMs));
}
