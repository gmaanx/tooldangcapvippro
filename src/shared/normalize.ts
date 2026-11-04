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

export function extractGamePin(input: string): string | null {
  if (!input || extractUuid(input)) {
    return null;
  }
  const trimmed = input.trim();
  const challengePinMatch = trimmed.match(
    /(?:\/challenge\/|[?&]pin=)(\d{5,10})\b/i
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

export function parseAnswerIndices(
  rawOutput: string,
  optionCount = 4,
  multiSelect = false
): number[] {
  if (!rawOutput) {
    return [];
  }
  const upperBound = Math.max(1, Math.min(optionCount, 8)) - 1;
  const strippedThink = rawOutput
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/<think>[\s\S]*$/gi, ' ')
    .trim();
  const digitMatches = strippedThink.match(/\b[0-7]\b/g);
  if (!digitMatches || digitMatches.length === 0) {
    return [];
  }

  const uniqueValid: number[] = [];
  for (const token of digitMatches) {
    const parsed = Number.parseInt(token, 10);
    if (
      Number.isInteger(parsed) &&
      parsed >= 0 &&
      parsed <= upperBound &&
      !uniqueValid.includes(parsed)
    ) {
      uniqueValid.push(parsed);
      if (!multiSelect) {
        break;
      }
    }
  }

  return uniqueValid;
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
