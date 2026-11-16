import {
  BATCH_CHUNK_SIZE,
  DEFAULT_SETTINGS,
  MAX_PARALLEL_BATCH_CHUNKS,
  STORAGE_KEYS,
  VISION_MAX_DIMENSION_PX,
  VISION_WEBP_QUALITY,
} from '../shared/constants';
import {
  buildContentSignature,
  buildQuestionStateHash,
  isKahootHostname,
  isWaygroundHostname,
  normalizeQuestionText,
  stripLeadingOptionPrefix,
} from '../shared/normalize';
import { loadSettings } from '../shared/storage';
import type {
  AnswerResolution,
  BatchQuestionItem,
  ClipboardExtractedPayload,
  ContentPushMessage,
  EngineSettings,
  QuestionKind,
  QuestionPayload,
  RuntimeBatchResolveResponse,
  RuntimeRequestMessage,
  RuntimeResolveResponse,
} from '../shared/types';

interface ScanSummary {
  detectedCount: number;
  solvedCount: number;
}

declare global {
  interface Window {
    __kheUniversalLmsInstalled?: boolean;
    __kheUniversalTriggerScan?: (force: boolean) => Promise<ScanSummary>;
  }
}

interface UniversalQuestionBlock {
  blockId: string;
  contentSig: string;
  container: HTMLElement;
  questionText: string;
  options: string[];
  optionElements: HTMLElement[];
  optionControls: HTMLElement[];
  selectControl?: HTMLSelectElement;
  selectOptionValues?: string[];
  multiSelect: boolean;
  questionKind: QuestionKind;
  blankInputs: Array<HTMLInputElement | HTMLTextAreaElement>;
  blankLengthHint?: number;
  forceRefresh?: boolean;
  verticalTop: number;
}

interface ResolvedBlockRecord {
  block: UniversalQuestionBlock;
  resolution: AnswerResolution;
}

const STEALTH_HIGHLIGHT_NAME = 'khe-stealth-answer';
const GOLD_OUTLINE_CSS = '2px solid rgba(245, 158, 11, 0.92)';
const GOLD_BG_CSS = 'rgba(251, 191, 36, 0.12)';
const STEALTH_FALLBACK_OUTLINE = '1px dotted rgba(100, 116, 139, 0.62)';
const MAX_CONCURRENT_REQUESTS = 2;

const BLOCKLISTED_AUTO_DOMAINS = [
  'youtube.com',
  'facebook.com',
  'messenger.com',
  'instagram.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'reddit.com',
  'netflix.com',
  'spotify.com',
  'shopee.vn',
  'lazada.vn',
  'tiki.vn',
  'amazon.com',
  'mail.google.com',
  'drive.google.com',
  'calendar.google.com',
  'chatgpt.com',
  'claude.ai',
  'gemini.google.com',
  'console.groq.com',
  'openrouter.ai',
  'aistudio.google.com',
];

const IDENTITY_FIELD_PATTERN =
  /\b(?:full\s*name|your\s*name|first\s*name|last\s*name|student\s*id|student\s*code|email|e-mail|phone|password|username|mssv|mã\s*sinh\s*viên|mã\s*số\s*sinh\s*viên|họ\s*và\s*tên|họ\s*tên|lớp|khoa|ngày\s*sinh|số\s*điện\s*thoại)\b/i;

const NAV_BUTTON_TEXT_PATTERN =
  /^(?:next|previous|prev|back|submit|finish|save|cancel|close|clear|reset|start|retry|continue|login|sign\s*in|register|nộp\s*bài|hoàn\s*thành|tiếp|tiếp\s*tục|câu\s*tiếp|câu\s*trước|quay\s*lại|xóa|làm\s*lại|bắt\s*đầu|đăng\s*nhập)$/i;

const QUIZ_KEYWORD_PATTERN =
  /\b(?:quiz|quizzes|exam|examination|assessment|test|attempt|multichoice|multiple\s*choice|question|questions|trắc\s*nghiệm|trac\s*nghiem|kiểm\s*tra|kiem\s*tra|bài\s*thi|bai\s*thi|ôn\s*tập|on\s*tap|câu\s*hỏi|cau\s*hoi|đề\s*thi|de\s*thi)\b/i;

const QUESTION_STEM_SIGNAL_PATTERN =
  /(?:\?|:\s*$|___|_{3,}|\.{4,}|^\s*(?:câu|cau|question|q|bài|bai)\s*\d+\b)/i;

const MOODLE_NOISE_PREFIX_PATTERN =
  /^(?:question\s*text|select\s*one(?:\s*or\s*more)?\s*:?|chọn\s*một(?:\s*hoặc\s*nhiều)?\s*:?|flag\s*question|đặt\s*cờ|marked\s*out\s*of\s*[\d.,]+|đạt\s*điểm\s*[\d.,]+)\s*/gi;

const FINAL_SUBMIT_DANGER_PATTERN =
  /(?:nộp\s*bài|nop\s*bai|hoàn\s*thành|hoan\s*thanh|làm\s*xong|lam\s*xong|kết\s*thúc|ket\s*thuc|gửi\s*bài|gui\s*bai|submit|finish|end\s*(?:quiz|test|exam|attempt)|summary|xóa\s*lựa\s*chọn|clear\s*my\s*choice)/i;

const NEXT_PAGE_SAFE_PATTERN =
  /^(?:trang\s*tiếp(?:\s*theo)?|câu\s*tiếp(?:\s*theo)?|tiếp\s*tục|trang\s*sau|next\s*page|next\s*question|next)\s*[»›→>▶]*$/i;

let currentSettings: EngineSettings = { ...DEFAULT_SETTINGS };
let manualScanActivated = false;
let styleSheetInjected = false;
let evalDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let autoNextTimer: ReturnType<typeof setTimeout> | null = null;
let hudToastHost: HTMLElement | null = null;
let hudToastTextEl: HTMLElement | null = null;
let hudToastTimer: ReturnType<typeof setTimeout> | null = null;
let programmaticActionActive = false;
let autoNextTriggeredOnPage = false;
let autoNextCanceledByUser = false;

const resolvedBlocks = new Map<string, ResolvedBlockRecord>();
const stateHashToSig = new Map<string, string>();
const inFlightSignatures = new Set<string>();
const harvestedReviewHashes = new Set<string>();
const styledElements = new Set<HTMLElement>();
const styledInputs = new Set<HTMLInputElement | HTMLTextAreaElement>();
const appliedAutoClickKeyBySig = new Map<string, string>();
const userManuallyEditedSigs = new Set<string>();

function sendRuntimeMessage<TResponse>(
  message: RuntimeRequestMessage
): Promise<TResponse | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response: TResponse) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(response ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

function ensureHighlightStylesheet(): void {
  if (styleSheetInjected || !document.head) {
    return;
  }
  styleSheetInjected = true;
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-khe-universal-style', '1');
  styleEl.textContent = [
    '::highlight(khe-stealth-answer){text-decoration-line:underline;text-decoration-style:dotted;text-decoration-color:rgba(100,116,139,0.75);text-decoration-thickness:1.5px;text-underline-offset:3px;}',
    'mark.khe-stealth-mark{background:transparent;color:inherit;text-decoration-line:underline;text-decoration-style:dotted;text-decoration-color:rgba(100,116,139,0.75);text-decoration-thickness:1.5px;text-underline-offset:3px;}',
    'span[data-khe-lms-badge="gold"]{display:inline-block;margin-inline-start:6px;padding:2px 7px;border-radius:5px;font-size:12px;font-weight:600;line-height:1.35;color:#92400e;background:rgba(254,243,199,0.95);border:1px solid rgba(245,158,11,0.75);vertical-align:middle;pointer-events:none;}',
    'span[data-khe-lms-badge="stealth"]{display:inline-block;margin-inline-start:6px;padding:0 2px;font-size:11px;font-weight:400;line-height:1.2;color:inherit;opacity:0.42;vertical-align:middle;pointer-events:none;}',
  ].join('');
  document.head.appendChild(styleEl);
}

function isElementVisible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement) || !el.isConnected || el.hidden) {
    return false;
  }
  const maybeCheckVis = (
    el as HTMLElement & {
      checkVisibility?: (opts?: {
        checkOpacity?: boolean;
        checkVisibilityCSS?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  if (typeof maybeCheckVis === 'function') {
    if (
      !maybeCheckVis.call(el, {
        checkOpacity: true,
        checkVisibilityCSS: true,
      })
    ) {
      return false;
    }
    return (
      el.offsetWidth > 2 ||
      el.offsetHeight > 2 ||
      el.getClientRects().length > 0
    );
  }
  if (el.closest('[hidden], [inert], template')) {
    return false;
  }
  const style = window.getComputedStyle(el);
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    Number.parseFloat(style.opacity || '1') <= 0.02
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 4 && rect.height > 4;
}

function isInsideExcludedPageChrome(el: Element): boolean {
  return (
    el.closest(
      'nav, header, footer, aside, [role="navigation"], [role="search"], [role="banner"], [role="contentinfo"], .navbar, .sidebar, .cookie-banner, #cookie-banner'
    ) !== null
  );
}

function extractRichMathText(
  root: Element | null | undefined,
  excludedSubtrees?: Set<Element>
): string {
  if (!root) {
    return '';
  }

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue ?? '';
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }
    const el = node as HTMLElement;
    if (excludedSubtrees?.has(el)) {
      return ' ';
    }
    const tag = el.tagName.toLowerCase();
    if (
      tag === 'style' ||
      tag === 'noscript' ||
      tag === 'template' ||
      tag === 'button' && el.hasAttribute('data-khe-ignore') ||
      el.hasAttribute('data-khe-lms-badge')
    ) {
      return '';
    }
    if (tag === 'script') {
      const scriptType = (el.getAttribute('type') ?? '').toLowerCase();
      if (scriptType.startsWith('math/tex')) {
        return ` ${el.textContent?.trim() ?? ''} `;
      }
      return '';
    }
    if (
      el.classList.contains('accesshide') ||
      el.classList.contains('sr-only') ||
      el.classList.contains('answernumber') ||
      el.classList.contains('specificfeedback') ||
      el.classList.contains('outcome') ||
      el.classList.contains('qtype_multichoice_clearchoice')
    ) {
      return ' ';
    }
    if (tag === 'sup' || tag === 'msup') {
      if (tag === 'msup' && el.children.length >= 2) {
        const base = walk(el.children[0]).trim();
        const exp = walk(el.children[1]).trim();
        return `${base}^{${exp}}`;
      }
      const innerSup = Array.from(el.childNodes).map(walk).join('').trim();
      return innerSup ? `^{${innerSup}}` : '';
    }
    if (tag === 'sub' || tag === 'msub') {
      if (tag === 'msub' && el.children.length >= 2) {
        const base = walk(el.children[0]).trim();
        const sub = walk(el.children[1]).trim();
        return `${base}_{${sub}}`;
      }
      const innerSub = Array.from(el.childNodes).map(walk).join('').trim();
      return innerSub ? `_{${innerSub}}` : '';
    }
    if (tag === 'msubsup' && el.children.length >= 3) {
      const base = walk(el.children[0]).trim();
      const sub = walk(el.children[1]).trim();
      const sup = walk(el.children[2]).trim();
      return `${base}_{${sub}}^{${sup}}`;
    }
    if (tag === 'mfrac' && el.children.length >= 2) {
      const num = walk(el.children[0]).trim();
      const den = walk(el.children[1]).trim();
      return `((${num})/(${den}))`;
    }
    if (tag === 'msqrt') {
      const innerSqrt = Array.from(el.childNodes).map(walk).join('').trim();
      return `sqrt(${innerSqrt})`;
    }
    if (tag === 'math') {
      const altTex =
        el.getAttribute('alttext') ?? el.getAttribute('aria-label');
      if (altTex && altTex.trim().length > 0) {
        return ` ${altTex.trim()} `;
      }
      const annot = el.querySelector('annotation[encoding="application/x-tex"]');
      if (annot?.textContent?.trim()) {
        return ` ${annot.textContent.trim()} `;
      }
    }
    if (el.classList.contains('katex')) {
      const texNode = el.querySelector('annotation[encoding="application/x-tex"]');
      if (texNode?.textContent?.trim()) {
        return ` ${texNode.textContent.trim()} `;
      }
      const htmlBranch = el.querySelector('.katex-html');
      if (htmlBranch) {
        return ` ${htmlBranch.textContent ?? ''} `;
      }
    }
    if (
      tag === 'mjx-container' ||
      el.classList.contains('MathJax') ||
      el.classList.contains('MathJax_Display')
    ) {
      const aria =
        el.getAttribute('aria-label') ?? el.getAttribute('data-latex');
      if (aria && aria.trim().length > 0) {
        return ` ${aria.trim()} `;
      }
    }
    if (tag === 'img') {
      const latex =
        el.getAttribute('data-latex') ??
        el.getAttribute('data-mathml') ??
        el.getAttribute('alt') ??
        '';
      const cleanedAlt = latex.trim();
      if (
        cleanedAlt.length > 0 &&
        !/^(?:image|img|photo|picture|icon|logo|untitled|\S+\.(?:png|jpg|jpeg|gif|svg|webp))$/i.test(
          cleanedAlt
        )
      ) {
        return ` ${cleanedAlt} `;
      }
      return ' ';
    }
    if (tag === 'br') {
      return '\n';
    }

    const parts: string[] = [];
    for (const child of Array.from(el.childNodes)) {
      parts.push(walk(child));
    }
    if (tag === 'td' || tag === 'th') {
      return ` ${parts.join('').replace(/\s+/g, ' ').trim()} | `;
    }
    if (
      tag === 'p' ||
      tag === 'div' ||
      tag === 'li' ||
      tag === 'tr' ||
      tag === 'pre'
    ) {
      return `\n${parts.join('')}\n`;
    }
    return parts.join('');
  };

  return walk(root)
    .replace(MOODLE_NOISE_PREFIX_PATTERN, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanQuestionStemText(raw: string): string {
  return raw
    .replace(MOODLE_NOISE_PREFIX_PATTERN, ' ')
    .replace(/\s*\*\s*$/, '')
    .replace(/\s*\(\d+(?:[.,]\d+)?\s*(?:points?|pts|điểm)\)\s*$/i, '')
    .replace(/\s+\d+(?:[.,]\d+)?\s*(?:points?|pts|điểm)\s*$/i, '')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanOptionItemText(raw: string, stripPrefix = true): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!stripPrefix) {
    return collapsed;
  }
  const stripped = stripLeadingOptionPrefix(collapsed);
  return stripped.length > 0 ? stripped : collapsed;
}

function resolveOptionRowForControl(
  control: HTMLElement,
  boundary: HTMLElement,
  allGroupControls: HTMLElement[]
): HTMLElement {
  if (control instanceof HTMLInputElement && control.id) {
    const wrappingLabel = control.closest('label');
    if (
      wrappingLabel &&
      boundary.contains(wrappingLabel) &&
      allGroupControls.filter((c) => wrappingLabel.contains(c)).length === 1
    ) {
      const parentRow = wrappingLabel.parentElement;
      if (
        parentRow &&
        parentRow !== boundary &&
        boundary.contains(parentRow) &&
        allGroupControls.filter((c) => parentRow.contains(c)).length === 1 &&
        parentRow.getBoundingClientRect().height < 220
      ) {
        return parentRow;
      }
      return wrappingLabel;
    }

    try {
      const explicitLabel = boundary.querySelector<HTMLLabelElement>(
        `label[for="${CSS.escape(control.id)}"]`
      );
      if (explicitLabel) {
        const sharedRow = explicitLabel.parentElement;
        if (
          sharedRow &&
          sharedRow !== boundary &&
          sharedRow.contains(control) &&
          allGroupControls.filter((c) => sharedRow.contains(c)).length === 1
        ) {
          return sharedRow;
        }
        return explicitLabel;
      }
    } catch {
      void 0;
    }
  }

  let candidate: HTMLElement = control;
  let cursor = control.parentElement;
  let depth = 0;
  while (cursor && cursor !== boundary && boundary.contains(cursor) && depth < 5) {
    const containedCount = allGroupControls.filter((item) =>
      cursor!.contains(item)
    ).length;
    if (containedCount > 1) {
      break;
    }
    const rect = cursor.getBoundingClientRect();
    if (rect.height > 240) {
      break;
    }
    candidate = cursor;
    cursor = cursor.parentElement;
    depth += 1;
  }
  return candidate;
}

function buildBlockRecord(
  container: HTMLElement,
  questionText: string,
  options: string[],
  optionElements: HTMLElement[],
  optionControls: HTMLElement[],
  multiSelect: boolean,
  questionKind: QuestionKind,
  blankInputs: Array<HTMLInputElement | HTMLTextAreaElement>,
  seqIndex: number
): UniversalQuestionBlock | null {
  const cleanedStem = cleanQuestionStemText(questionText);
  if (cleanedStem.length < 3) {
    return null;
  }
  if (questionKind === 'fill_blank') {
    if (blankInputs.length === 0) {
      return null;
    }
    if (IDENTITY_FIELD_PATTERN.test(cleanedStem)) {
      return null;
    }
    const firstInput = blankInputs[0];
    const ph = `${firstInput.placeholder || ''} ${firstInput.name || ''} ${firstInput.id || ''}`;
    if (IDENTITY_FIELD_PATTERN.test(ph)) {
      return null;
    }
    const contentSig = buildContentSignature(cleanedStem, ['__fill_blank__']);
    const blockId = buildQuestionStateHash(
      seqIndex,
      cleanedStem,
      ['__fill_blank__'],
      'text'
    );
    const maxLen =
      firstInput instanceof HTMLInputElement &&
      firstInput.maxLength > 0 &&
      firstInput.maxLength <= 40
        ? firstInput.maxLength
        : undefined;
    return {
      blockId,
      contentSig,
      container,
      questionText: cleanedStem,
      options: [],
      optionElements: [],
      optionControls: [],
      multiSelect: false,
      questionKind: 'fill_blank',
      blankInputs,
      blankLengthHint: maxLen,
      verticalTop: container.getBoundingClientRect().top,
    };
  }

  if (options.length < 2 || options.length !== optionElements.length) {
    return null;
  }
  const nonEmptyCount = options.filter((opt) => opt.trim().length > 0).length;
  if (nonEmptyCount < 2) {
    return null;
  }

  const contentSig = buildContentSignature(cleanedStem, options);
  const blockId = buildQuestionStateHash(seqIndex, cleanedStem, options, 'text');
  return {
    blockId,
    contentSig,
    container,
    questionText: cleanedStem,
    options,
    optionElements,
    optionControls:
      optionControls.length === options.length ? optionControls : optionElements,
    multiSelect,
    questionKind: 'choice',
    blankInputs: [],
    verticalTop: container.getBoundingClientRect().top,
  };
}

function harvestMoodleReviewVerifiedAnswer(
  queEl: HTMLElement,
  questionText: string,
  options: string[]
): void {
  if (options.length < 2 || !questionText) {
    return;
  }
  const rightAnswerEl = queEl.querySelector<HTMLElement>('.outcome .rightanswer');
  if (!rightAnswerEl) {
    return;
  }
  const rawRight = extractRichMathText(rightAnswerEl);
  if (!rawRight) {
    return;
  }
  const colonIdx = rawRight.indexOf(':');
  const answerPortion = (colonIdx >= 0 ? rawRight.slice(colonIdx + 1) : rawRight).trim();
  if (!answerPortion) {
    return;
  }

  const normAnswerPortion = normalizeQuestionText(
    stripLeadingOptionPrefix(answerPortion)
  );
  if (!normAnswerPortion) {
    return;
  }

  const matchedIndices: number[] = [];
  options.forEach((opt, idx) => {
    const normOpt = normalizeQuestionText(opt);
    if (!normOpt) {
      return;
    }
    if (
      normOpt === normAnswerPortion ||
      (normOpt.length >= 4 && normAnswerPortion.includes(normOpt))
    ) {
      matchedIndices.push(idx);
    }
  });

  if (matchedIndices.length === 0) {
    return;
  }

  const sig = buildContentSignature(questionText, options);
  if (harvestedReviewHashes.has(sig)) {
    return;
  }
  harvestedReviewHashes.add(sig);

  void sendRuntimeMessage<{ ok: boolean }>({
    type: 'LEARN_VERIFIED_ANSWER',
    questionText,
    options,
    indices: matchedIndices,
  });
}

function extractMoodleBlocks(
  claimedContainers: WeakSet<Element>,
  claimedControls: WeakSet<Element>,
  startIndex: number
): UniversalQuestionBlock[] {
  const results: UniversalQuestionBlock[] = [];
  const moodleNodes = Array.from(document.querySelectorAll<HTMLElement>('div.que'));

  for (const queEl of moodleNodes) {
    if (!isElementVisible(queEl) || claimedContainers.has(queEl)) {
      continue;
    }
    const qtextEl =
      queEl.querySelector<HTMLElement>('.qtext') ??
      queEl.querySelector<HTMLElement>('.formulation');
    if (!qtextEl) {
      continue;
    }

    const answerArea = queEl.querySelector<HTMLElement>('.answer, .ablock');
    const excluded = new Set<Element>();
    if (answerArea) {
      excluded.add(answerArea);
    }
    const stem = extractRichMathText(qtextEl, excluded);
    if (!stem) {
      continue;
    }

    const choiceInputs = Array.from(
      queEl.querySelectorAll<HTMLInputElement>(
        '.answer input[type="radio"], .answer input[type="checkbox"]'
      )
    ).filter(
      (inp) =>
        Boolean(inp.name) &&
        !inp.name.endsWith(':flagged') &&
        inp.value !== '-1' &&
        !inp.id.endsWith('_answer-1') &&
        !inp.closest('.qtype_multichoice_clearchoice')
    );

    if (choiceInputs.length >= 2 && choiceInputs.length <= 12) {
      const multiSelect = choiceInputs.some((inp) => inp.type === 'checkbox');
      const boundary =
        queEl.querySelector<HTMLElement>('.answer') ?? queEl;
      const optionElements: HTMLElement[] = [];
      const options: string[] = [];

      for (const inp of choiceInputs) {
        claimedControls.add(inp);
        const row = resolveOptionRowForControl(inp, boundary, choiceInputs);
        optionElements.push(row);
        options.push(cleanOptionItemText(extractRichMathText(row), true));
      }

      harvestMoodleReviewVerifiedAnswer(queEl, stem, options);

      const built = buildBlockRecord(
        queEl,
        stem,
        options,
        optionElements,
        choiceInputs,
        multiSelect,
        'choice',
        [],
        startIndex + results.length
      );
      if (built) {
        claimedContainers.add(queEl);
        results.push(built);
      }
      continue;
    }

    const textInputs = Array.from(
      queEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '.answer input[type="text"], .answer input[type="number"], .ablock input[type="text"], .ablock input[type="number"], .formulation input[type="text"]:not([readonly])'
      )
    ).filter((inp) => isElementVisible(inp) && !inp.disabled && !inp.readOnly);

    if (textInputs.length === 1) {
      claimedControls.add(textInputs[0]);
      const built = buildBlockRecord(
        queEl,
        stem,
        [],
        [],
        [],
        false,
        'fill_blank',
        textInputs,
        startIndex + results.length
      );
      if (built) {
        claimedContainers.add(queEl);
        results.push(built);
      }
      continue;
    }

    const selectControls = Array.from(
      queEl.querySelectorAll<HTMLSelectElement>(
        '.answer select, .ablock select, .formulation select'
      )
    ).filter((sel) => isElementVisible(sel) && !sel.disabled);

    if (selectControls.length >= 1 && selectControls.length <= 10) {
      let addedSelect = false;
      for (const sel of selectControls) {
        const validOptionEntries = Array.from(sel.options)
          .filter(
            (opt) =>
              opt.value !== '' &&
              !/^(?:choose|chọn|select)\b/i.test(opt.text.trim())
          )
          .map((opt) => ({
            value: opt.value,
            label: opt.text.replace(/\s+/g, ' ').trim(),
          }))
          .filter((entry) => entry.label.length > 0);

        if (validOptionEntries.length < 2 || validOptionEntries.length > 12) {
          continue;
        }
        const validOpts = validOptionEntries.map((entry) => entry.label);
        const rowCell = sel.closest('tr')?.querySelector<HTMLElement>('td.text');
        const subPrompt = rowCell ? extractRichMathText(rowCell) : '';
        const fullStem = subPrompt
          ? `${stem}\nMatch target: ${subPrompt}`
          : stem;
        const placeholderEls = validOpts.map(() => sel as HTMLElement);
        const built = buildBlockRecord(
          queEl,
          fullStem,
          validOpts,
          placeholderEls,
          placeholderEls,
          false,
          'choice',
          [],
          startIndex + results.length
        );
        if (built) {
          built.selectControl = sel;
          built.selectOptionValues = validOptionEntries.map(
            (entry) => entry.value
          );
          claimedControls.add(sel);
          results.push(built);
          addedSelect = true;
        }
      }
      if (addedSelect) {
        claimedContainers.add(queEl);
      }
    }
  }

  return results;
}

function extractCanvasBlocks(
  claimedContainers: WeakSet<Element>,
  claimedControls: WeakSet<Element>,
  startIndex: number
): UniversalQuestionBlock[] {
  const results: UniversalQuestionBlock[] = [];
  const canvasNodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.display_question.question, [data-automation="sdk-take-item-question"]'
    )
  );

  for (const qEl of canvasNodes) {
    if (!isElementVisible(qEl) || claimedContainers.has(qEl)) {
      continue;
    }
    const stemEl =
      qEl.querySelector<HTMLElement>(
        '.question_text, [data-automation="sdk-take-item-stimulus"]'
      ) ?? qEl;
    const answersWrapper = qEl.querySelector<HTMLElement>('.answers');
    const excluded = new Set<Element>();
    if (answersWrapper) {
      excluded.add(answersWrapper);
    }
    const stem = extractRichMathText(stemEl, excluded);
    if (!stem) {
      continue;
    }

    const controls = Array.from(
      qEl.querySelectorAll<HTMLElement>(
        'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
      )
    );
    if (controls.length >= 2 && controls.length <= 12) {
      const multiSelect = controls.some(
        (c) =>
          (c instanceof HTMLInputElement && c.type === 'checkbox') ||
          c.getAttribute('role') === 'checkbox'
      );
      const boundary = answersWrapper ?? qEl;
      const optionElements: HTMLElement[] = [];
      const options: string[] = [];

      for (const ctrl of controls) {
        claimedControls.add(ctrl);
        const row = resolveOptionRowForControl(ctrl, boundary, controls);
        optionElements.push(row);
        options.push(cleanOptionItemText(extractRichMathText(row)));
      }

      const built = buildBlockRecord(
        qEl,
        stem,
        options,
        optionElements,
        controls,
        multiSelect,
        'choice',
        [],
        startIndex + results.length
      );
      if (built) {
        claimedContainers.add(qEl);
        results.push(built);
      }
      continue;
    }

    const blankInputs = Array.from(
      qEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        '.answers input[type="text"], .answers input[type="number"], input.question_input'
      )
    ).filter((inp) => isElementVisible(inp) && !inp.disabled && !inp.readOnly);

    if (blankInputs.length === 1) {
      claimedControls.add(blankInputs[0]);
      const built = buildBlockRecord(
        qEl,
        stem,
        [],
        [],
        [],
        false,
        'fill_blank',
        blankInputs,
        startIndex + results.length
      );
      if (built) {
        claimedContainers.add(qEl);
        results.push(built);
      }
    }
  }

  return results;
}

function extractFormsBlocks(
  claimedContainers: WeakSet<Element>,
  claimedControls: WeakSet<Element>,
  startIndex: number
): UniversalQuestionBlock[] {
  const results: UniversalQuestionBlock[] = [];
  const host = window.location.hostname.toLowerCase();
  const isGoogleForms =
    host === 'docs.google.com' &&
    window.location.pathname.includes('/forms/');
  const isMsForms =
    host.includes('forms.office.com') ||
    host.includes('forms.cloud.microsoft') ||
    document.querySelector('[data-automation-id="questionItem"]') !== null;

  if (!isGoogleForms && !isMsForms) {
    return results;
  }

  const cardSelector = isGoogleForms
    ? '[role="listitem"]'
    : '[data-automation-id="questionItem"]';
  const cards = Array.from(document.querySelectorAll<HTMLElement>(cardSelector));

  for (const card of cards) {
    if (!isElementVisible(card) || claimedContainers.has(card)) {
      continue;
    }
    const headingEl = isGoogleForms
      ? card.querySelector<HTMLElement>('[role="heading"]')
      : card.querySelector<HTMLElement>('[data-automation-id="questionTitle"]');
    if (!headingEl) {
      continue;
    }
    const stem = extractRichMathText(headingEl);
    if (!stem) {
      continue;
    }

    const choiceItems = isGoogleForms
      ? Array.from(
          card.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]')
        ).filter((el) => isElementVisible(el))
      : Array.from(
          card.querySelectorAll<HTMLElement>('[data-automation-id="choiceItem"]')
        ).filter((el) => isElementVisible(el));

    if (choiceItems.length >= 2 && choiceItems.length <= 12) {
      const multiSelect = choiceItems.some(
        (el) =>
          el.getAttribute('role') === 'checkbox' ||
          el.querySelector('[role="checkbox"], input[type="checkbox"]') !== null
      );
      const optionElements: HTMLElement[] = [];
      const optionControls: HTMLElement[] = [];
      const options: string[] = [];

      for (const item of choiceItems) {
        claimedControls.add(item);
        item
          .querySelectorAll('input, [role="radio"], [role="checkbox"]')
          .forEach((sub) => claimedControls.add(sub));
        const row = isGoogleForms
          ? resolveOptionRowForControl(item, card, choiceItems)
          : item;
        const interactiveCtrl = isGoogleForms
          ? item
          : item.querySelector<HTMLElement>(
              'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]'
            ) ?? item;
        optionElements.push(row);
        optionControls.push(interactiveCtrl);
        const rawOpt =
          item.getAttribute('data-value') ||
          extractRichMathText(row) ||
          item.getAttribute('aria-label') ||
          '';
        options.push(cleanOptionItemText(rawOpt));
      }

      const built = buildBlockRecord(
        card,
        stem,
        options,
        optionElements,
        optionControls,
        multiSelect,
        'choice',
        [],
        startIndex + results.length
      );
      if (built) {
        claimedContainers.add(card);
        results.push(built);
      }
      continue;
    }

    const textInputs = Array.from(
      card.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"], input:not([type]), textarea'
      )
    ).filter((inp) => isElementVisible(inp) && !inp.disabled && !inp.readOnly);

    if (textInputs.length === 1) {
      claimedControls.add(textInputs[0]);
      const built = buildBlockRecord(
        card,
        stem,
        [],
        [],
        [],
        false,
        'fill_blank',
        textInputs,
        startIndex + results.length
      );
      if (built) {
        claimedContainers.add(card);
        results.push(built);
      }
    }
  }

  return results;
}

function findLowestCommonAncestor(elements: HTMLElement[]): HTMLElement | null {
  if (elements.length === 0) {
    return null;
  }
  let candidate: HTMLElement | null = elements[0].parentElement;
  while (candidate && candidate !== document.body) {
    if (elements.every((el) => candidate!.contains(el))) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return document.body;
}

function findQuestionContainerAndStem(
  firstOptionRow: HTMLElement,
  optionsLca: HTMLElement,
  claimedContainers: WeakSet<Element>
): { container: HTMLElement; stem: string } | null {
  let cursor: HTMLElement | null = optionsLca;
  let depth = 0;

  while (cursor && cursor !== document.body && depth < 5) {
    if (!claimedContainers.has(cursor) && !isInsideExcludedPageChrome(cursor)) {
      const explicitStem = cursor.querySelector<HTMLElement>(
        'legend, .question-text, .question-title, .q-text, .stem, .prompt, [class*="question-text"], [class*="question-title"], [class*="questionPrompt"], h1, h2, h3, h4, h5'
      );
      if (
        explicitStem &&
        !firstOptionRow.contains(explicitStem) &&
        (explicitStem.compareDocumentPosition(firstOptionRow) &
          Node.DOCUMENT_POSITION_FOLLOWING) !==
          0
      ) {
        const stemText = cleanQuestionStemText(extractRichMathText(explicitStem));
        if (stemText.length >= 4) {
          return { container: cursor, stem: stemText };
        }
      }

      const precedingParts: string[] = [];
      const walker = document.createTreeWalker(cursor, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (firstOptionRow.contains(node)) {
          break;
        }
        const cmp = node.compareDocumentPosition(firstOptionRow);
        if ((cmp & Node.DOCUMENT_POSITION_FOLLOWING) === 0) {
          break;
        }
        const parentEl = node.parentElement;
        if (
          parentEl &&
          !parentEl.closest('script, style, noscript, [data-khe-lms-badge]')
        ) {
          const val = node.nodeValue?.trim() ?? '';
          if (val.length > 0) {
            precedingParts.push(val);
          }
        }
        node = walker.nextNode();
      }

      const combined = cleanQuestionStemText(precedingParts.join(' '));
      if (combined.length >= 5 && combined.length <= 1600) {
        return { container: cursor, stem: combined };
      }
    }
    cursor = cursor.parentElement;
    depth += 1;
  }

  return null;
}

function extractGenericControlGroupBlocks(
  claimedContainers: WeakSet<Element>,
  claimedControls: WeakSet<Element>,
  startIndex: number
): UniversalQuestionBlock[] {
  const results: UniversalQuestionBlock[] = [];

  const allInputs = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      'input[type="radio"], input[type="checkbox"]'
    )
  ).filter((inp) => {
    if (
      claimedControls.has(inp) ||
      inp.disabled ||
      inp.value === '-1' ||
      inp.id.endsWith('_answer-1') ||
      inp.closest('.qtype_multichoice_clearchoice')
    ) {
      return false;
    }
    if (isInsideExcludedPageChrome(inp)) {
      return false;
    }
    if (inp.closest('div.que, .display_question.question')) {
      return false;
    }
    const row = inp.closest('label') ?? inp.parentElement;
    return isElementVisible(inp) || isElementVisible(row);
  });

  const groups: HTMLInputElement[][] = [];
  const byName = new Map<string, HTMLInputElement[]>();
  const nameless: HTMLInputElement[] = [];

  for (const inp of allInputs) {
    const trimmedName = (inp.name || '').trim();
    if (trimmedName.length > 0) {
      const formIndex = inp.form
        ? Array.from(document.forms).indexOf(inp.form)
        : -1;
      const key = `${formIndex}::${inp.type}::${trimmedName}`;
      const list = byName.get(key) ?? [];
      list.push(inp);
      byName.set(key, list);
    } else {
      nameless.push(inp);
    }
  }

  for (const list of byName.values()) {
    if (list.length >= 2 && list.length <= 12) {
      groups.push(list);
    } else if (list.length === 1) {
      nameless.push(list[0]);
    }
  }

  const byParent = new Map<HTMLElement, HTMLInputElement[]>();
  for (const inp of nameless) {
    const groupParent = inp.closest<HTMLElement>(
      'fieldset, [role="radiogroup"], [role="group"], [class*="question"], [class*="quiz"], [class*="options"], [class*="choices"], [class*="answers"], ul, ol'
    );
    if (groupParent) {
      const list = byParent.get(groupParent) ?? [];
      list.push(inp);
      byParent.set(groupParent, list);
    }
  }
  for (const list of byParent.values()) {
    if (list.length >= 2 && list.length <= 12) {
      groups.push(list);
    }
  }

  for (const group of groups) {
    const lca = findLowestCommonAncestor(group);
    if (!lca || claimedContainers.has(lca)) {
      continue;
    }
    const optionElements = group.map((inp) =>
      resolveOptionRowForControl(inp, lca, group)
    );
    if (new Set(optionElements).size < 2) {
      continue;
    }
    const options = optionElements.map((row) =>
      cleanOptionItemText(extractRichMathText(row))
    );
    if (options.some((opt) => NAV_BUTTON_TEXT_PATTERN.test(opt))) {
      continue;
    }

    const located = findQuestionContainerAndStem(
      optionElements[0],
      lca,
      claimedContainers
    );
    if (!located) {
      continue;
    }

    const multiSelect = group.some((inp) => inp.type === 'checkbox');
    const built = buildBlockRecord(
      located.container,
      located.stem,
      options,
      optionElements,
      group,
      multiSelect,
      'choice',
      [],
      startIndex + results.length
    );
    if (built) {
      group.forEach((inp) => claimedControls.add(inp));
      claimedContainers.add(located.container);
      results.push(built);
    }
  }

  const ariaGroups = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="radiogroup"], [role="listbox"]'
    )
  ).filter((g) => isElementVisible(g) && !claimedContainers.has(g) && !isInsideExcludedPageChrome(g));

  for (const ariaGroup of ariaGroups) {
    const items = Array.from(
      ariaGroup.querySelectorAll<HTMLElement>(
        '[role="radio"], [role="checkbox"], [role="option"]'
      )
    ).filter((item) => isElementVisible(item) && !claimedControls.has(item));

    if (items.length < 2 || items.length > 12) {
      continue;
    }
    const optionElements = items.map((item) =>
      resolveOptionRowForControl(item, ariaGroup, items)
    );
    const options = optionElements.map((row) =>
      cleanOptionItemText(extractRichMathText(row))
    );
    const located = findQuestionContainerAndStem(
      optionElements[0],
      ariaGroup,
      claimedContainers
    );
    if (!located) {
      continue;
    }
    const multiSelect = items.some(
      (item) => item.getAttribute('role') === 'checkbox'
    );
    const built = buildBlockRecord(
      located.container,
      located.stem,
      options,
      optionElements,
      items,
      multiSelect,
      'choice',
      [],
      startIndex + results.length
    );
    if (built) {
      items.forEach((item) => claimedControls.add(item));
      claimedContainers.add(located.container);
      results.push(built);
    }
  }

  return results;
}

function extractCustomCardBlocks(
  claimedContainers: WeakSet<Element>,
  claimedControls: WeakSet<Element>,
  startIndex: number,
  forceMode: boolean
): UniversalQuestionBlock[] {
  const results: UniversalQuestionBlock[] = [];
  const cardSelector = forceMode
    ? '[class*="question"], [id*="question"], [data-question], [class*="quiz"], [class*="mcq"], fieldset, article, section'
    : '[class*="question"], [id*="question"], [data-question], [class*="quiz-card"], [class*="quiz-item"], [class*="mcq"]';

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(cardSelector)
  ).filter(
    (el) =>
      isElementVisible(el) &&
      !claimedContainers.has(el) &&
      !isInsideExcludedPageChrome(el)
  );

  for (const card of candidates) {
    if (
      candidates.some(
        (other) => other !== card && card.contains(other) && other.querySelectorAll('button, li, [class*="option"], [class*="choice"]').length >= 2
      )
    ) {
      continue;
    }

    const rawOptions = Array.from(
      card.querySelectorAll<HTMLElement>(
        '[class*="option"]:not([class*="options"]), [class*="choice"]:not([class*="choices"]), [class*="answer-item"], [data-option], button:not([type="submit"]), ul > li, ol > li'
      )
    ).filter((el) => {
      if (!isElementVisible(el) || claimedControls.has(el)) {
        return false;
      }
      if (isInsideExcludedPageChrome(el)) {
        return false;
      }
      const txt = extractRichMathText(el);
      if (txt.length === 0 || txt.length > 500) {
        return false;
      }
      return !NAV_BUTTON_TEXT_PATTERN.test(txt);
    });

    const dedupedOptions: HTMLElement[] = [];
    for (const el of rawOptions) {
      if (
        dedupedOptions.some((prev) => prev.contains(el) || el.contains(prev))
      ) {
        continue;
      }
      dedupedOptions.push(el);
    }

    if (dedupedOptions.length < 2 || dedupedOptions.length > 10) {
      continue;
    }

    const firstTag = dedupedOptions[0].tagName;
    if (!dedupedOptions.every((el) => el.tagName === firstTag)) {
      continue;
    }

    const lca = findLowestCommonAncestor(dedupedOptions) ?? card;
    const located = findQuestionContainerAndStem(
      dedupedOptions[0],
      lca,
      claimedContainers
    );
    if (!located) {
      continue;
    }

    if (!forceMode && !QUESTION_STEM_SIGNAL_PATTERN.test(located.stem)) {
      continue;
    }

    const options = dedupedOptions.map((el) =>
      cleanOptionItemText(extractRichMathText(el))
    );

    const built = buildBlockRecord(
      card,
      located.stem,
      options,
      dedupedOptions,
      dedupedOptions,
      false,
      'choice',
      [],
      startIndex + results.length
    );
    if (built) {
      dedupedOptions.forEach((el) => claimedControls.add(el));
      claimedContainers.add(card);
      results.push(built);
    }
  }

  return results;
}

function extractUniversalQuestionBlocks(
  forceMode: boolean
): UniversalQuestionBlock[] {
  const claimedContainers = new WeakSet<Element>();
  const claimedControls = new WeakSet<Element>();
  const allBlocks: UniversalQuestionBlock[] = [];

  const moodleBlocks = extractMoodleBlocks(claimedContainers, claimedControls, 0);
  if (moodleBlocks.length > 0) {
    allBlocks.push(...moodleBlocks);
    if (!forceMode) {
      return allBlocks;
    }
  }

  const canvasBlocks = extractCanvasBlocks(
    claimedContainers,
    claimedControls,
    allBlocks.length
  );
  if (canvasBlocks.length > 0) {
    allBlocks.push(...canvasBlocks);
    if (!forceMode) {
      return allBlocks;
    }
  }

  const formsBlocks = extractFormsBlocks(
    claimedContainers,
    claimedControls,
    allBlocks.length
  );
  if (formsBlocks.length > 0) {
    allBlocks.push(...formsBlocks);
    if (!forceMode) {
      return allBlocks;
    }
  }

  allBlocks.push(
    ...extractGenericControlGroupBlocks(
      claimedContainers,
      claimedControls,
      allBlocks.length
    )
  );
  allBlocks.push(
    ...extractCustomCardBlocks(
      claimedContainers,
      claimedControls,
      allBlocks.length,
      forceMode
    )
  );

  return allBlocks;
}

function extractPageAcademicContext(): string {
  const genericNoise =
    /^(?:bảng\s*điều\s*khiển|dashboard|trang\s*chủ(?:\s*hệ\s*thống)?|home|my\s*courses|các\s*khoá\s*học\s*của\s*tôi|các\s*khóa\s*học\s*của\s*tôi|courses|ueh\s*lms)$/i;

  const crumbs = Array.from(
    document.querySelectorAll<HTMLElement>(
      '.breadcrumb li, .breadcrumb a, #page-navbar li, #page-navbar a, nav[aria-label*="breadcrumb" i] li'
    )
  )
    .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((txt) => txt.length > 1 && txt.length < 120 && !genericNoise.test(txt));

  const uniqueCrumbs: string[] = [];
  for (const item of crumbs) {
    if (!uniqueCrumbs.includes(item)) {
      uniqueCrumbs.push(item);
    }
  }

  const heading = (
    document.querySelector<HTMLElement>(
      '.page-header-headings h1, main h1, h1'
    )?.textContent ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  if (heading && !genericNoise.test(heading) && !uniqueCrumbs.includes(heading)) {
    uniqueCrumbs.push(heading);
  }

  if (uniqueCrumbs.length > 0) {
    return uniqueCrumbs.slice(-5).join(' > ');
  }

  const cleanTitle = (document.title ?? '').replace(/\s+/g, ' ').trim();
  return cleanTitle.slice(0, 180);
}

function isKnownLmsEnvironment(): boolean {
  const host = window.location.hostname.toLowerCase();
  const href = window.location.href.toLowerCase();
  return (
    host.includes('lms.') ||
    host.startsWith('lms') ||
    host.includes('moodle') ||
    host.includes('elearning') ||
    host.includes('instructure.com') ||
    host.includes('blackboard') ||
    host.includes('azota') ||
    host.includes('shub') ||
    (host === 'docs.google.com' && href.includes('/forms/')) ||
    host.includes('forms.office.com') ||
    host.includes('forms.cloud.microsoft') ||
    href.includes('/mod/quiz/')
  );
}

function isHostBlocklistedForAutoScan(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return BLOCKLISTED_AUTO_DOMAINS.some(
    (domain) => lower === domain || lower.endsWith(`.${domain}`)
  );
}

function isPageEligibleForAutoScan(blocks: UniversalQuestionBlock[]): boolean {
  if (blocks.length === 0) {
    return false;
  }
  if (manualScanActivated) {
    return true;
  }

  const host = window.location.hostname.toLowerCase();
  if (isHostBlocklistedForAutoScan(host)) {
    return false;
  }

  const hrefLower = window.location.href.toLowerCase();
  if (
    document.querySelector(
      'div.que, .display_question.question, [data-automation="sdk-take-item-question"], [data-automation-id="questionItem"]'
    ) !== null
  ) {
    return true;
  }

  if (
    (host === 'docs.google.com' && hrefLower.includes('/forms/')) ||
    host.includes('forms.office.com') ||
    host.includes('forms.cloud.microsoft') ||
    host.includes('lms.') ||
    host.startsWith('lms') ||
    host.includes('moodle') ||
    host.includes('elearning') ||
    host.includes('instructure.com') ||
    host.includes('blackboard') ||
    host.includes('azota') ||
    host.includes('shub') ||
    host.includes('myaloha') ||
    host.includes('quizlet.com') ||
    host.includes('testportal') ||
    host.includes('classmarker') ||
    host.includes('socrative')
  ) {
    return true;
  }

  const headingText = Array.from(document.querySelectorAll('h1, h2'))
    .slice(0, 4)
    .map((h) => h.textContent ?? '')
    .join(' ');
  const pageMetaSignal = `${document.title} ${headingText} ${window.location.pathname}`;
  if (QUIZ_KEYWORD_PATTERN.test(pageMetaSignal)) {
    return true;
  }

  const academicStemCount = blocks.filter((b) =>
    QUESTION_STEM_SIGNAL_PATTERN.test(b.questionText)
  ).length;
  return blocks.length >= 2 && academicStemCount >= 2;
}

function collectTextNodeRanges(root: HTMLElement): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current) {
    const parentEl = current.parentElement;
    if (
      parentEl &&
      !parentEl.closest(
        'script, style, noscript, .accesshide, .sr-only, [data-khe-lms-badge]'
      )
    ) {
      const raw = current.nodeValue ?? '';
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        const start = raw.indexOf(trimmed);
        if (start >= 0) {
          const r = new Range();
          r.setStart(current, start);
          r.setEnd(current, start + trimmed.length);
          ranges.push(r);
        }
      }
    }
    current = walker.nextNode();
  }
  return ranges;
}

function unwrapStealthFallbackMarks(): void {
  document.querySelectorAll<HTMLElement>('mark.khe-stealth-mark').forEach((mark) => {
    const parent = mark.parentNode;
    if (parent) {
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    }
  });
}

function wrapElementTextWithStealthMarks(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    if (
      n instanceof Text &&
      (n.nodeValue?.trim().length ?? 0) > 0 &&
      n.parentElement &&
      !n.parentElement.closest('script, style, mark.khe-stealth-mark, [data-khe-lms-badge]')
    ) {
      nodes.push(n);
    }
    n = walker.nextNode();
  }

  for (const textNode of nodes) {
    const raw = textNode.nodeValue ?? '';
    const trimmed = raw.trim();
    const start = raw.indexOf(trimmed);
    if (start < 0) {
      continue;
    }
    const frag = document.createDocumentFragment();
    if (start > 0) {
      frag.append(raw.slice(0, start));
    }
    const mark = document.createElement('mark');
    mark.className = 'khe-stealth-mark';
    mark.textContent = trimmed;
    frag.append(mark);
    const end = start + trimmed.length;
    if (end < raw.length) {
      frag.append(raw.slice(end));
    }
    textNode.replaceWith(frag);
  }
}

function clearAllVisualHighlights(): void {
  try {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights) {
      CSS.highlights.delete(STEALTH_HIGHLIGHT_NAME);
    }
  } catch {
    void 0;
  }

  unwrapStealthFallbackMarks();

  for (const el of styledElements) {
    const origOutline = el.getAttribute('data-khe-orig-outline') ?? '';
    const origOffset = el.getAttribute('data-khe-orig-offset') ?? '';
    const origBg = el.getAttribute('data-khe-orig-bg') ?? '';
    const origRadius = el.getAttribute('data-khe-orig-radius') ?? '';
    el.style.outline = origOutline;
    el.style.outlineOffset = origOffset;
    el.style.backgroundColor = origBg;
    el.style.borderRadius = origRadius;
    el.removeAttribute('data-khe-orig-outline');
    el.removeAttribute('data-khe-orig-offset');
    el.removeAttribute('data-khe-orig-bg');
    el.removeAttribute('data-khe-orig-radius');
  }
  styledElements.clear();

  for (const inp of styledInputs) {
    const origOutline = inp.getAttribute('data-khe-orig-outline') ?? '';
    const origPh = inp.getAttribute('data-khe-orig-ph');
    inp.style.outline = origOutline;
    inp.style.outlineOffset = '';
    inp.removeAttribute('data-khe-orig-outline');
    if (origPh !== null) {
      inp.placeholder = origPh;
      inp.removeAttribute('data-khe-orig-ph');
    }
  }
  styledInputs.clear();

  document
    .querySelectorAll('[data-khe-lms-badge]')
    .forEach((badge) => badge.remove());
}

function rememberOriginalBoxStyle(el: HTMLElement): void {
  if (!el.hasAttribute('data-khe-orig-outline')) {
    el.setAttribute('data-khe-orig-outline', el.style.outline || '');
    el.setAttribute('data-khe-orig-offset', el.style.outlineOffset || '');
    el.setAttribute('data-khe-orig-bg', el.style.backgroundColor || '');
    el.setAttribute('data-khe-orig-radius', el.style.borderRadius || '');
  }
  styledElements.add(el);
}

async function yieldToMainThread(): Promise<void> {
  const win = window as Window & {
    scheduler?: { yield?: () => Promise<void> };
  };
  if (win.scheduler && typeof win.scheduler.yield === 'function') {
    await win.scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function isReviewOrReadOnlyAttemptPage(container?: HTMLElement): boolean {
  const pathLower = window.location.pathname.toLowerCase();
  if (pathLower.includes('/review.php')) {
    return true;
  }
  if (container && container.querySelector('.outcome .rightanswer') !== null) {
    return true;
  }
  return false;
}

function dispatchSyntheticOptionClick(target: HTMLElement): void {
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  };
  if (typeof PointerEvent === 'function') {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { ...eventInit, pointerId: 1, isPrimary: true })
    );
  }
  target.dispatchEvent(new MouseEvent('mousedown', eventInit));
  if (typeof PointerEvent === 'function') {
    target.dispatchEvent(
      new PointerEvent('pointerup', { ...eventInit, pointerId: 1, isPrimary: true })
    );
  }
  target.dispatchEvent(new MouseEvent('mouseup', eventInit));
  target.click();
}

function isDangerousSubmitOrNavElement(el: HTMLElement | undefined): boolean {
  if (!el) {
    return true;
  }
  if (
    el instanceof HTMLAnchorElement &&
    el.href &&
    !el.getAttribute('href')?.startsWith('#') &&
    !el.getAttribute('href')?.toLowerCase().startsWith('javascript:')
  ) {
    return true;
  }
  const rawLabel = (
    (el instanceof HTMLInputElement ? el.value : el.textContent) ||
    el.getAttribute('aria-label') ||
    ''
  )
    .replace(/\s+/g, ' ')
    .trim();
  if (
    rawLabel.length > 0 &&
    (FINAL_SUBMIT_DANGER_PATTERN.test(rawLabel) ||
      NAV_BUTTON_TEXT_PATTERN.test(rawLabel))
  ) {
    return true;
  }
  return false;
}

function setControlCheckedState(
  ctrl: HTMLElement | undefined,
  rowEl: HTMLElement | undefined,
  shouldCheck: boolean
): void {
  if (!ctrl || !document.body.contains(ctrl)) {
    return;
  }

  if (
    ctrl instanceof HTMLInputElement &&
    (ctrl.type === 'radio' || ctrl.type === 'checkbox')
  ) {
    if (
      ctrl.disabled ||
      ctrl.value === '-1' ||
      ctrl.closest('.qtype_multichoice_clearchoice')
    ) {
      return;
    }
    if (ctrl.checked === shouldCheck) {
      return;
    }
    if (!shouldCheck && ctrl.type === 'radio') {
      return;
    }

    ctrl.click();

    if (ctrl.checked !== shouldCheck) {
      const associatedLabel =
        ctrl.labels?.[0] ??
        (rowEl instanceof HTMLLabelElement
          ? rowEl
          : rowEl?.querySelector<HTMLLabelElement>('label') ?? null);
      if (associatedLabel && !isDangerousSubmitOrNavElement(associatedLabel)) {
        associatedLabel.click();
      }
    }

    if (ctrl.checked !== shouldCheck) {
      const checkedSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'checked'
      )?.set;
      if (checkedSetter) {
        checkedSetter.call(ctrl, shouldCheck);
      } else {
        ctrl.checked = shouldCheck;
      }
      ctrl.dispatchEvent(new Event('input', { bubbles: true }));
      ctrl.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }

  const role = (ctrl.getAttribute('role') ?? '').toLowerCase();
  if (role === 'radio' || role === 'checkbox' || role === 'option') {
    if (ctrl.getAttribute('aria-disabled') === 'true') {
      return;
    }
    const ariaVal =
      ctrl.getAttribute('aria-checked') ?? ctrl.getAttribute('aria-selected');
    const isChecked = ariaVal === 'true';
    if (isChecked === shouldCheck) {
      return;
    }
    if (!shouldCheck && role === 'radio') {
      return;
    }
    dispatchSyntheticOptionClick(ctrl);
    return;
  }

  if (!shouldCheck) {
    return;
  }
  if (
    ctrl instanceof HTMLButtonElement &&
    ctrl.type === 'submit' &&
    !ctrl.hasAttribute('data-option') &&
    !/option|choice|answer/i.test(ctrl.className)
  ) {
    return;
  }
  if (isDangerousSubmitOrNavElement(ctrl)) {
    return;
  }
  dispatchSyntheticOptionClick(ctrl);
}

function isSelectionCurrentlyAppliedInDom(
  block: UniversalQuestionBlock,
  resolution: AnswerResolution
): boolean {
  if (block.selectControl && document.body.contains(block.selectControl)) {
    const winIdx = resolution.indices[0];
    const expectedVal =
      typeof winIdx === 'number'
        ? block.selectOptionValues?.[winIdx]
        : undefined;
    return Boolean(expectedVal && block.selectControl.value === expectedVal);
  }
  if (block.questionKind === 'fill_blank' && resolution.fillText) {
    const inp = block.blankInputs[0];
    return Boolean(inp && inp.value.trim() === resolution.fillText.trim());
  }
  if (resolution.indices.length === 0) {
    return false;
  }
  return resolution.indices.every((idx) => {
    const ctrl = block.optionControls[idx];
    if (ctrl instanceof HTMLInputElement) {
      return ctrl.checked;
    }
    if (ctrl?.hasAttribute('aria-checked')) {
      return ctrl.getAttribute('aria-checked') === 'true';
    }
    return true;
  });
}

function applyAutoClickToResolvedBlock(
  sig: string,
  block: UniversalQuestionBlock,
  resolution: AnswerResolution,
  forceOverride = false
): void {
  if (
    !currentSettings.enabled ||
    !currentSettings.lmsAutoClickEnabled ||
    !document.body.contains(block.container) ||
    isReviewOrReadOnlyAttemptPage(block.container)
  ) {
    return;
  }
  if (!forceOverride && userManuallyEditedSigs.has(sig)) {
    return;
  }

  const selectionKey =
    block.questionKind === 'fill_blank'
      ? `fill:${resolution.fillText ?? ''}`
      : `idx:${[...resolution.indices].sort((a, b) => a - b).join(',')}`;

  if (
    !forceOverride &&
    appliedAutoClickKeyBySig.get(sig) === selectionKey &&
    isSelectionCurrentlyAppliedInDom(block, resolution)
  ) {
    return;
  }

  programmaticActionActive = true;
  try {
    if (block.selectControl && document.body.contains(block.selectControl)) {
      const sel = block.selectControl;
      const winIdx = resolution.indices[0];
      const targetVal =
        typeof winIdx === 'number'
          ? block.selectOptionValues?.[winIdx]
          : undefined;
      if (targetVal !== undefined && !sel.disabled && sel.value !== targetVal) {
        const valSetter = Object.getOwnPropertyDescriptor(
          HTMLSelectElement.prototype,
          'value'
        )?.set;
        if (valSetter) {
          valSetter.call(sel, targetVal);
        } else {
          sel.value = targetVal;
        }
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      appliedAutoClickKeyBySig.set(sig, selectionKey);
      return;
    }

    if (block.questionKind === 'fill_blank' && resolution.fillText) {
      const targetInput = block.blankInputs[0];
      if (
        targetInput &&
        document.body.contains(targetInput) &&
        !targetInput.disabled &&
        !targetInput.readOnly &&
        targetInput.value !== resolution.fillText
      ) {
        const proto =
          targetInput instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const valSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (valSetter) {
          valSetter.call(targetInput, resolution.fillText);
        } else {
          targetInput.value = resolution.fillText;
        }
        targetInput.dispatchEvent(
          new InputEvent('input', {
            bubbles: true,
            inputType: 'insertText',
            data: resolution.fillText,
          })
        );
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
      }
      appliedAutoClickKeyBySig.set(sig, selectionKey);
      return;
    }

    if (resolution.indices.length === 0) {
      return;
    }

    if (block.multiSelect) {
      const targetSet = new Set(resolution.indices);
      for (let i = 0; i < block.optionControls.length; i += 1) {
        setControlCheckedState(
          block.optionControls[i],
          block.optionElements[i],
          targetSet.has(i)
        );
      }
    } else {
      const winIdx = resolution.indices[0];
      if (typeof winIdx === 'number') {
        setControlCheckedState(
          block.optionControls[winIdx],
          block.optionElements[winIdx],
          true
        );
      }
    }

    appliedAutoClickKeyBySig.set(sig, selectionKey);
  } finally {
    programmaticActionActive = false;
  }
}

function findSafeNextPageButton(): HTMLElement | null {
  const navButtons = Array.from(
    document.querySelectorAll<HTMLElement>(
      '#mod_quiz_navblock .qnbutton, .othernav .qnbutton, [data-region="quiz-nav-panel"] .qnbutton'
    )
  );
  if (navButtons.length > 0) {
    const currentIdx = navButtons.findIndex((el) =>
      el.classList.contains('thispage')
    );
    if (currentIdx >= 0 && currentIdx === navButtons.length - 1) {
      return null;
    }
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      '#mod_quiz-next-nav, input.mod_quiz-next-nav, button.mod_quiz-next-nav, input[name="next"], button[name="next"], input[type="submit"], button[type="submit"], button:not([type="button"])'
    )
  );

  for (const el of candidates) {
    if (!isElementVisible(el)) {
      continue;
    }
    if (
      (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) &&
      el.disabled
    ) {
      continue;
    }
    const rawLabel = (
      (el instanceof HTMLInputElement ? el.value : el.textContent) ||
      el.getAttribute('aria-label') ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim();

    if (!rawLabel || FINAL_SUBMIT_DANGER_PATTERN.test(rawLabel)) {
      continue;
    }
    if (NEXT_PAGE_SAFE_PATTERN.test(rawLabel)) {
      return el;
    }
  }

  return null;
}

function cancelScheduledAutoNext(): void {
  if (autoNextTimer !== null) {
    clearTimeout(autoNextTimer);
    autoNextTimer = null;
  }
}

function maybeScheduleAutoNextPage(): void {
  cancelScheduledAutoNext();
  if (
    !currentSettings.enabled ||
    !currentSettings.lmsAutoClickEnabled ||
    !currentSettings.lmsAutoNextPage ||
    autoNextTriggeredOnPage ||
    autoNextCanceledByUser ||
    isReviewOrReadOnlyAttemptPage() ||
    inFlightSignatures.size > 0
  ) {
    return;
  }

  const liveBlocks = extractUniversalQuestionBlocks(false);
  if (liveBlocks.length === 0) {
    return;
  }

  const now = Date.now();
  for (const b of liveBlocks) {
    const rec = resolvedBlocks.get(b.contentSig);
    if (!rec) {
      return;
    }
    if (rec.resolution.disputed && now - rec.resolution.timestamp < 4800) {
      autoNextTimer = setTimeout(() => {
        autoNextTimer = null;
        maybeScheduleAutoNextPage();
      }, 360);
      return;
    }
  }

  const nextBtn = findSafeNextPageButton();
  if (!nextBtn) {
    return;
  }

  autoNextTimer = setTimeout(() => {
    autoNextTimer = null;
    if (
      !currentSettings.enabled ||
      !currentSettings.lmsAutoClickEnabled ||
      !currentSettings.lmsAutoNextPage ||
      autoNextTriggeredOnPage ||
      autoNextCanceledByUser ||
      inFlightSignatures.size > 0
    ) {
      return;
    }
    const confirmedBtn = findSafeNextPageButton();
    if (confirmedBtn) {
      autoNextTriggeredOnPage = true;
      programmaticActionActive = true;
      try {
        confirmedBtn.click();
      } finally {
        programmaticActionActive = false;
      }
    }
  }, 240);
}

async function applyAutoClickForAllResolved(
  forceOverride = false
): Promise<void> {
  if (!currentSettings.enabled || !currentSettings.lmsAutoClickEnabled) {
    return;
  }
  const entries = Array.from(resolvedBlocks.entries());
  let deadline = performance.now() + 50;

  for (const [sig, entry] of entries) {
    applyAutoClickToResolvedBlock(
      sig,
      entry.block,
      entry.resolution,
      forceOverride
    );
    if (performance.now() >= deadline) {
      await yieldToMainThread();
      deadline = performance.now() + 50;
    }
  }

  maybeScheduleAutoNextPage();
}

function renderAllResolvedHighlights(): void {
  clearAllVisualHighlights();
  if (!currentSettings.enabled) {
    return;
  }

  ensureHighlightStylesheet();
  const isStealth = currentSettings.highlightStyle === 'stealth';
  const autoClicking = currentSettings.lmsAutoClickEnabled;
  const supportsCustomHighlight =
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    Boolean(CSS.highlights) &&
    typeof Highlight !== 'undefined';

  const stealthRanges: Range[] = [];

  for (const [sig, entry] of resolvedBlocks.entries()) {
    if (!document.body.contains(entry.block.container)) {
      resolvedBlocks.delete(sig);
      continue;
    }

    const { block, resolution } = entry;
    if (block.selectControl && document.body.contains(block.selectControl)) {
      const sel = block.selectControl;
      const winIdx = resolution.indices[0];
      const winLabel =
        typeof winIdx === 'number' ? block.options[winIdx] ?? '' : '';
      if (winLabel) {
        if (!isStealth) {
          rememberOriginalBoxStyle(sel);
          sel.style.outline = GOLD_OUTLINE_CSS;
          sel.style.outlineOffset = '1px';
        }
        if (!isStealth || !autoClicking) {
          const badge = document.createElement('span');
          badge.setAttribute('data-khe-lms-badge', isStealth ? 'stealth' : 'gold');
          badge.setAttribute('aria-hidden', 'true');
          badge.textContent = isStealth ? `(${winLabel})` : winLabel;
          sel.insertAdjacentElement('afterend', badge);
        }
      }
      continue;
    }

    if (block.questionKind === 'fill_blank' && resolution.fillText) {
      const targetInput = block.blankInputs[0];
      if (!targetInput || !document.body.contains(targetInput)) {
        continue;
      }

      if (!targetInput.hasAttribute('data-khe-orig-outline')) {
        targetInput.setAttribute(
          'data-khe-orig-outline',
          targetInput.style.outline || ''
        );
      }
      styledInputs.add(targetInput);

      if (isStealth) {
        if (!autoClicking) {
          if (!targetInput.value && !targetInput.placeholder) {
            targetInput.setAttribute('data-khe-orig-ph', '');
            targetInput.placeholder = resolution.fillText;
          } else {
            const badge = document.createElement('span');
            badge.setAttribute('data-khe-lms-badge', 'stealth');
            badge.setAttribute('aria-hidden', 'true');
            badge.textContent = `(${resolution.fillText})`;
            targetInput.insertAdjacentElement('afterend', badge);
          }
        }
      } else {
        targetInput.style.outline = GOLD_OUTLINE_CSS;
        targetInput.style.outlineOffset = '1px';
        if (!autoClicking) {
          const badge = document.createElement('span');
          badge.setAttribute('data-khe-lms-badge', 'gold');
          badge.setAttribute('aria-hidden', 'true');
          badge.textContent = resolution.fillText;
          targetInput.insertAdjacentElement('afterend', badge);
        }
      }
      continue;
    }

    for (const idx of resolution.indices) {
      const targetEl = block.optionElements[idx];
      if (!targetEl || !document.body.contains(targetEl)) {
        continue;
      }

      if (isStealth) {
        if (!autoClicking) {
          if (supportsCustomHighlight) {
            const nodeRanges = collectTextNodeRanges(targetEl);
            if (nodeRanges.length > 0) {
              stealthRanges.push(...nodeRanges);
            } else {
              rememberOriginalBoxStyle(targetEl);
              targetEl.style.outline = STEALTH_FALLBACK_OUTLINE;
              targetEl.style.outlineOffset = '1px';
            }
          } else {
            const hasText = collectTextNodeRanges(targetEl).length > 0;
            if (hasText) {
              wrapElementTextWithStealthMarks(targetEl);
            } else {
              rememberOriginalBoxStyle(targetEl);
              targetEl.style.outline = STEALTH_FALLBACK_OUTLINE;
              targetEl.style.outlineOffset = '1px';
            }
          }
        }
      } else {
        rememberOriginalBoxStyle(targetEl);
        targetEl.style.outline = GOLD_OUTLINE_CSS;
        targetEl.style.outlineOffset = '2px';
        targetEl.style.backgroundColor = GOLD_BG_CSS;
        if (!targetEl.style.borderRadius) {
          targetEl.style.borderRadius = '6px';
        }
      }
    }
  }

  if (isStealth && !autoClicking && supportsCustomHighlight && stealthRanges.length > 0) {
    CSS.highlights.set(STEALTH_HIGHLIGHT_NAME, new Highlight(...stealthRanges));
  }
}

function showDiscreteToast(message: string, isError = false, durationMs = 2400): void {
  if (!document.body || currentSettings.highlightStyle === 'stealth') {
    if (hudToastTextEl) {
      hudToastTextEl.style.opacity = '0';
    }
    return;
  }

  if (!hudToastHost || !hudToastTextEl || !document.body.contains(hudToastHost)) {
    hudToastHost = document.createElement('div');
    hudToastHost.style.position = 'fixed';
    hudToastHost.style.right = '12px';
    hudToastHost.style.bottom = '12px';
    hudToastHost.style.zIndex = '2147483647';
    hudToastHost.style.pointerEvents = 'none';

    const shadow = hudToastHost.attachShadow({ mode: 'closed' });
    const pill = document.createElement('div');
    pill.style.padding = '6px 11px';
    pill.style.borderRadius = '7px';
    pill.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    pill.style.fontSize = '12px';
    pill.style.fontWeight = '600';
    pill.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.22)';
    pill.style.transition = 'opacity 140ms ease';
    shadow.appendChild(pill);
    hudToastTextEl = pill;
    document.body.appendChild(hudToastHost);
  }

  hudToastTextEl.textContent = message;
  hudToastTextEl.style.backgroundColor = isError
    ? 'rgba(127, 29, 29, 0.94)'
    : 'rgba(20, 23, 38, 0.92)';
  hudToastTextEl.style.color = isError ? '#fecaca' : '#fde047';
  hudToastTextEl.style.border = isError
    ? '1px solid rgba(248, 113, 113, 0.6)'
    : '1px solid rgba(245, 158, 11, 0.65)';
  hudToastTextEl.style.opacity = '1';

  if (hudToastTimer !== null) {
    clearTimeout(hudToastTimer);
  }
  hudToastTimer = setTimeout(() => {
    if (hudToastTextEl) {
      hudToastTextEl.style.opacity = '0';
    }
  }, durationMs);
}

async function extractEmbeddedImagesFromBlock(
  container: HTMLElement
): Promise<{
  base64: string;
  mimeType: 'image/webp';
} | null> {
  const imgs = Array.from(container.querySelectorAll<HTMLImageElement>('img')).filter(
    (img) => {
      if (
        img.closest('.outcome, .specificfeedback, [data-khe-lms-badge]') ||
        img.classList.contains('icon') ||
        img.classList.contains('emoticon')
      ) {
        return false;
      }
      const hasFullLatex = Boolean(
        img.getAttribute('data-latex')?.trim() ||
          img.classList.contains('texrender')
      );
      if (hasFullLatex) {
        return false;
      }
      const rect = img.getBoundingClientRect();
      const w = Math.max(img.naturalWidth || 0, rect.width);
      const h = Math.max(img.naturalHeight || 0, rect.height);
      return w >= 36 && h >= 18;
    }
  );

  if (imgs.length === 0) {
    return null;
  }

  const bitmaps: ImageBitmap[] = [];
  for (const img of imgs.slice(0, 3)) {
    const src = img.currentSrc || img.src;
    if (!src) {
      continue;
    }
    try {
      const resp = await fetch(src, { credentials: 'include' });
      if (resp.ok) {
        const blob = await resp.blob();
        bitmaps.push(await createImageBitmap(blob));
        continue;
      }
    } catch {
      void 0;
    }
    try {
      if (img.complete && img.naturalWidth > 0) {
        bitmaps.push(await createImageBitmap(img));
      }
    } catch {
      void 0;
    }
  }

  if (bitmaps.length === 0) {
    return null;
  }

  try {
    const gap = 10;
    const rawMaxW = Math.max(...bitmaps.map((b) => b.width));
    const rawTotalH =
      bitmaps.reduce((acc, b) => acc + b.height, 0) +
      gap * Math.max(0, bitmaps.length - 1);
    const scale = Math.min(1, 1100 / Math.max(rawMaxW, rawTotalH));
    const canvasW = Math.max(1, Math.round(rawMaxW * scale));
    const canvasH = Math.max(1, Math.round(rawTotalH * scale));

    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmaps.forEach((b) => b.close());
      return null;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    let y = 0;
    for (const bmp of bitmaps) {
      const drawW = Math.max(1, Math.round(bmp.width * scale));
      const drawH = Math.max(1, Math.round(bmp.height * scale));
      ctx.drawImage(bmp, 0, y, drawW, drawH);
      y += drawH + Math.round(gap * scale);
      bmp.close();
    }

    const webpBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.76)
    );
    if (!webpBlob) {
      return null;
    }
    return {
      base64: encodeBytesToBase64(await webpBlob.arrayBuffer()),
      mimeType: 'image/webp',
    };
  } catch {
    bitmaps.forEach((b) => {
      try {
        b.close();
      } catch {
        void 0;
      }
    });
    return null;
  }
}

function hasContentImageCandidates(container: HTMLElement): boolean {
  return Array.from(container.querySelectorAll<HTMLImageElement>('img')).some(
    (img) => {
      if (
        img.closest('.outcome, .specificfeedback, [data-khe-lms-badge]') ||
        img.classList.contains('icon') ||
        img.classList.contains('emoticon') ||
        Boolean(img.getAttribute('data-latex')?.trim()) ||
        img.classList.contains('texrender')
      ) {
        return false;
      }
      const rect = img.getBoundingClientRect();
      const w = Math.max(img.naturalWidth || 0, rect.width);
      const h = Math.max(img.naturalHeight || 0, rect.height);
      return w >= 36 && h >= 18;
    }
  );
}

async function resolveSingleUniversalBlock(
  block: UniversalQuestionBlock,
  pageContext: string
): Promise<boolean> {
  const embeddedImg = await extractEmbeddedImagesFromBlock(block.container);
  const payload: QuestionPayload = {
    stateHash: block.blockId,
    questionIndex: 0,
    questionText: block.questionText,
    options: block.options,
    multiSelect: block.multiSelect,
    optionCount: block.options.length || 4,
    source: 'dom',
    platform: 'universal',
    questionKind: block.questionKind,
    blankLengthHint: block.blankLengthHint,
    deepAccuracy: true,
    forceRefresh: Boolean(block.forceRefresh),
    pageContext,
    imageBase64: embeddedImg?.base64,
    imageMimeType: embeddedImg?.mimeType,
  };

  stateHashToSig.set(block.blockId, block.contentSig);

  const response = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'RESOLVE_QUESTION',
    payload,
  });

  if (response && response.ok && response.resolution) {
    resolvedBlocks.set(block.contentSig, {
      block,
      resolution: response.resolution,
    });
    renderAllResolvedHighlights();
    applyAutoClickToResolvedBlock(
      block.contentSig,
      block,
      response.resolution,
      Boolean(block.forceRefresh)
    );
    maybeScheduleAutoNextPage();
    return true;
  }

  return false;
}

async function resolveChoiceBatchChunk(
  chunk: UniversalQuestionBlock[],
  pageContext: string,
  forceRefresh: boolean
): Promise<void> {
  if (chunk.length === 0) {
    return;
  }
  if (chunk.length === 1) {
    try {
      await resolveSingleUniversalBlock(chunk[0], pageContext);
    } finally {
      inFlightSignatures.delete(chunk[0].contentSig);
    }
    return;
  }

  const byHash = new Map<string, UniversalQuestionBlock>();
  const batchItems: BatchQuestionItem[] = chunk.map((b, idx) => {
    byHash.set(b.blockId, b);
    stateHashToSig.set(b.blockId, b.contentSig);
    return {
      stateHash: b.blockId,
      questionIndex: idx,
      questionText: b.questionText,
      options: b.options,
      multiSelect: b.multiSelect,
      optionCount: b.options.length,
    };
  });

  try {
    const batchRes = await sendRuntimeMessage<RuntimeBatchResolveResponse>({
      type: 'RESOLVE_QUESTION_BATCH',
      payload: {
        items: batchItems,
        pageContext,
        forceRefresh,
      },
    });

    if (batchRes?.ok && Array.isArray(batchRes.resolutions)) {
      const resolvedHashes = new Set<string>();
      for (const itemRes of batchRes.resolutions) {
        const matchedBlock = byHash.get(itemRes.stateHash);
        if (matchedBlock && itemRes.indices.length > 0) {
          resolvedHashes.add(itemRes.stateHash);
          resolvedBlocks.set(matchedBlock.contentSig, {
            block: matchedBlock,
            resolution: {
              stateHash: itemRes.stateHash,
              questionIndex: itemRes.questionIndex,
              indices: itemRes.indices,
              questionKind: 'choice',
              tier: itemRes.tier,
              latencyMs: itemRes.latencyMs,
              timestamp: Date.now(),
              multiSelect: matchedBlock.multiSelect,
              triggerMode: currentSettings.lmsAutoClickEnabled
                ? 'instant_auto_click'
                : 'highlight_only',
              highlightStyle: currentSettings.highlightStyle,
              voteSummary: itemRes.voteSummary,
              disputed: Boolean(itemRes.disputed),
            },
          });
        }
      }
      renderAllResolvedHighlights();
      void applyAutoClickForAllResolved(forceRefresh);

      const missedBlocks = chunk.filter((b) => !resolvedHashes.has(b.blockId));
      for (const missed of missedBlocks) {
        await resolveSingleUniversalBlock(missed, pageContext);
      }
      return;
    }

    await Promise.all(
      chunk.map((b) => resolveSingleUniversalBlock(b, pageContext))
    );
  } finally {
    for (const b of chunk) {
      inFlightSignatures.delete(b.contentSig);
    }
  }
}

async function dispatchTurboParallelResolution(
  blocksToSolve: UniversalQuestionBlock[],
  pageContext: string,
  forceRefresh: boolean
): Promise<void> {
  const pureChoiceBlocks: UniversalQuestionBlock[] = [];
  const individualBlocks: UniversalQuestionBlock[] = [];

  for (const b of blocksToSolve) {
    if (
      b.questionKind === 'choice' &&
      !hasContentImageCandidates(b.container)
    ) {
      pureChoiceBlocks.push(b);
    } else {
      individualBlocks.push(b);
    }
  }

  const chunks: UniversalQuestionBlock[][] = [];
  for (let i = 0; i < pureChoiceBlocks.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(pureChoiceBlocks.slice(i, i + BATCH_CHUNK_SIZE));
  }

  const chunkTasks = async (): Promise<void> => {
    for (let w = 0; w < chunks.length; w += MAX_PARALLEL_BATCH_CHUNKS) {
      const wave = chunks.slice(w, w + MAX_PARALLEL_BATCH_CHUNKS);
      await Promise.all(
        wave.map((chunk) =>
          resolveChoiceBatchChunk(chunk, pageContext, forceRefresh)
        )
      );
    }
  };

  const individualTasks = async (): Promise<void> => {
    let cursor = 0;
    const workerCount = Math.min(MAX_CONCURRENT_REQUESTS, individualBlocks.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < individualBlocks.length) {
        const current = individualBlocks[cursor];
        cursor += 1;
        try {
          await resolveSingleUniversalBlock(current, pageContext);
        } finally {
          inFlightSignatures.delete(current.contentSig);
        }
      }
    });
    await Promise.all(workers);
  };

  await Promise.all([chunkTasks(), individualTasks()]);
}

async function solveSelectedTextIfPresent(): Promise<boolean> {
  const selection = window.getSelection();
  const selectedText = selection?.toString().trim() ?? '';
  if (selectedText.length < 12) {
    return false;
  }

  const lines = selectedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const optionLinePattern = /^\(?([A-Ha-h1-8])\)?[.):\-]\s+(.+)$/;
  const stemLines: string[] = [];
  const parsedOptions: string[] = [];

  for (const line of lines) {
    const m = line.match(optionLinePattern);
    if (m) {
      parsedOptions.push(m[2].trim());
    } else if (parsedOptions.length === 0) {
      stemLines.push(line);
    }
  }

  const anchorEl =
    selection?.anchorNode instanceof HTMLElement
      ? selection.anchorNode
      : selection?.anchorNode?.parentElement ?? null;

  if (parsedOptions.length >= 2 && stemLines.length >= 1) {
    const stem = stemLines.join(' ');
    const stateHash = buildQuestionStateHash(
      Date.now(),
      stem,
      parsedOptions,
      'text'
    );
    const res = await sendRuntimeMessage<RuntimeResolveResponse>({
      type: 'RESOLVE_QUESTION',
      payload: {
        stateHash,
        questionIndex: 0,
        questionText: stem,
        options: parsedOptions,
        multiSelect: false,
        optionCount: parsedOptions.length,
        source: 'dom',
        platform: 'universal',
        questionKind: 'choice',
      },
    });
    if (res?.ok && res.resolution && res.resolution.indices.length > 0) {
      const idx = res.resolution.indices[0];
      const winningText = parsedOptions[idx] ?? '';
      const letter = String.fromCharCode(65 + idx);
      if (anchorEl && winningText) {
        highlightSubstringInContainer(
          anchorEl.closest('article, section, form, main, div') ?? document.body,
          winningText
        );
      }
      showDiscreteToast(`Answer: ${letter}. ${winningText}`, false, 4200);
      return true;
    }
  }

  const stateHash = buildQuestionStateHash(
    Date.now(),
    selectedText,
    ['__fill_blank__'],
    'text'
  );
  const res = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'RESOLVE_QUESTION',
    payload: {
      stateHash,
      questionIndex: 0,
      questionText: selectedText,
      options: [],
      multiSelect: false,
      optionCount: 0,
      source: 'dom',
      platform: 'universal',
      questionKind: 'fill_blank',
    },
  });

  if (res?.ok && res.resolution?.fillText) {
    if (anchorEl) {
      highlightSubstringInContainer(
        anchorEl.closest('article, section, form, main, div') ?? document.body,
        res.resolution.fillText
      );
    }
    showDiscreteToast(`Answer: ${res.resolution.fillText}`, false, 4500);
    return true;
  }

  return false;
}

function highlightSubstringInContainer(
  container: HTMLElement,
  targetPhrase: string
): void {
  const cleanTarget = targetPhrase.trim().toLowerCase();
  if (cleanTarget.length < 2) {
    return;
  }
  ensureHighlightStylesheet();
  const supportsCustomHighlight =
    typeof CSS !== 'undefined' &&
    'highlights' in CSS &&
    Boolean(CSS.highlights) &&
    typeof Highlight !== 'undefined';

  if (!supportsCustomHighlight) {
    return;
  }

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const ranges: Range[] = [];
  let current = walker.nextNode();
  while (current) {
    const val = current.nodeValue ?? '';
    const pos = val.toLowerCase().indexOf(cleanTarget);
    if (pos >= 0) {
      const r = new Range();
      r.setStart(current, pos);
      r.setEnd(current, pos + cleanTarget.length);
      ranges.push(r);
    }
    current = walker.nextNode();
  }

  if (ranges.length > 0) {
    CSS.highlights.set(STEALTH_HIGHLIGHT_NAME, new Highlight(...ranges));
  }
}

function sortBlocksViewportFirst(
  blocks: UniversalQuestionBlock[]
): UniversalQuestionBlock[] {
  const viewportHeight = window.innerHeight || 800;
  return [...blocks].sort((a, b) => {
    const aVisible = a.verticalTop >= -120 && a.verticalTop <= viewportHeight + 160;
    const bVisible = b.verticalTop >= -120 && b.verticalTop <= viewportHeight + 160;
    if (aVisible !== bVisible) {
      return aVisible ? -1 : 1;
    }
    return a.verticalTop - b.verticalTop;
  });
}

async function runUniversalPageScan(forceMode: boolean): Promise<ScanSummary> {
  if (!currentSettings.enabled) {
    return { detectedCount: 0, solvedCount: 0 };
  }
  if (!forceMode && !currentSettings.universalHighlightEnabled) {
    return { detectedCount: 0, solvedCount: 0 };
  }

  if (forceMode) {
    manualScanActivated = true;
    autoNextCanceledByUser = false;
    userManuallyEditedSigs.clear();
    appliedAutoClickKeyBySig.clear();
    const solvedSelection = await solveSelectedTextIfPresent();
    if (solvedSelection) {
      return { detectedCount: 1, solvedCount: 1 };
    }
    resolvedBlocks.clear();
  }

  const blocks = extractUniversalQuestionBlocks(forceMode);
  if (blocks.length === 0) {
    return { detectedCount: 0, solvedCount: 0 };
  }

  if (!forceMode && !isPageEligibleForAutoScan(blocks)) {
    return { detectedCount: 0, solvedCount: 0 };
  }

  const pageContext = extractPageAcademicContext();
  const ordered = sortBlocksViewportFirst(blocks);
  const toDispatch: UniversalQuestionBlock[] = [];

  for (const block of ordered) {
    if (forceMode) {
      block.forceRefresh = true;
    }
    stateHashToSig.set(block.blockId, block.contentSig);
    const existing = resolvedBlocks.get(block.contentSig);
    if (existing) {
      existing.block = block;
      continue;
    }
    if (inFlightSignatures.has(block.contentSig)) {
      continue;
    }
    inFlightSignatures.add(block.contentSig);
    toDispatch.push(block);
  }

  renderAllResolvedHighlights();
  void applyAutoClickForAllResolved(forceMode);

  if (toDispatch.length > 0) {
    if (forceMode) {
      await dispatchTurboParallelResolution(toDispatch, pageContext, true);
    } else {
      void dispatchTurboParallelResolution(toDispatch, pageContext, false);
    }
  } else {
    maybeScheduleAutoNextPage();
  }

  const solvedOnPage = blocks.filter((b) =>
    resolvedBlocks.has(b.contentSig)
  ).length;

  if (forceMode && blocks.length > 0) {
    const modeLabel = currentSettings.lmsAutoClickEnabled
      ? 'Solved & auto-selected'
      : 'Highlighted';
    showDiscreteToast(
      `${modeLabel} ${solvedOnPage}/${blocks.length} question(s) on page.`
    );
  }

  return {
    detectedCount: blocks.length,
    solvedCount: solvedOnPage,
  };
}

function scheduleAutoEvaluation(delayMs = 260): void {
  if (evalDebounceTimer !== null) {
    return;
  }
  evalDebounceTimer = setTimeout(() => {
    evalDebounceTimer = null;
    void runUniversalPageScan(false);
  }, delayMs);
}

function encodeBytesToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const segments: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    segments.push(String.fromCharCode(...slice));
  }
  return btoa(segments.join(''));
}

async function compressImageBlob(
  blob: Blob
): Promise<{
  base64: string;
  mimeType: 'image/webp' | 'image/png' | 'image/jpeg';
}> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(
      1,
      VISION_MAX_DIMENSION_PX / Math.max(bitmap.width, bitmap.height)
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const webpBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/webp', VISION_WEBP_QUALITY)
      );
      if (webpBlob) {
        return {
          base64: encodeBytesToBase64(await webpBlob.arrayBuffer()),
          mimeType: 'image/webp',
        };
      }
    } else {
      bitmap.close();
    }
  } catch {
    void 0;
  }
  return {
    base64: encodeBytesToBase64(await blob.arrayBuffer()),
    mimeType: blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
  };
}

function isEditableFocused(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable
  );
}

async function handleImagePasteOnExternalPage(
  event: ClipboardEvent
): Promise<void> {
  if (!currentSettings.enabled || isEditableFocused(event.target)) {
    return;
  }
  const data = event.clipboardData;
  if (!data) {
    return;
  }

  let imageFile: File | null = null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.type.startsWith('image/')) {
      imageFile = item.getAsFile();
      if (imageFile) {
        break;
      }
    }
  }
  if (!imageFile) {
    return;
  }

  event.preventDefault();
  showDiscreteToast('Solving pasted screenshot...');

  const compressed = await compressImageBlob(imageFile);
  const payload: ClipboardExtractedPayload = {
    kind: 'image',
    base64: compressed.base64,
    mimeType: compressed.mimeType,
  };

  const blocks = extractUniversalQuestionBlocks(true);
  const singleBlock = blocks.length === 1 ? blocks[0] : null;
  const stateHash = buildQuestionStateHash(
    Date.now(),
    'universal-paste-image',
    [],
    'vision'
  );

  const res = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'RESOLVE_DIRECT_CLIPBOARD_PAYLOAD',
    stateHash,
    questionIndex: 0,
    optionCount: singleBlock?.options.length || 4,
    multiSelect: Boolean(singleBlock?.multiSelect),
    questionKind: singleBlock?.questionKind ?? 'choice',
    blankLengthHint: singleBlock?.blankLengthHint,
    clipboard: payload,
  });

  if (res?.ok && res.resolution) {
    if (singleBlock) {
      resolvedBlocks.set(singleBlock.contentSig, {
        block: singleBlock,
        resolution: res.resolution,
      });
      renderAllResolvedHighlights();
      applyAutoClickToResolvedBlock(
        singleBlock.contentSig,
        singleBlock,
        res.resolution,
        true
      );
    }
    const label =
      res.resolution.questionKind === 'fill_blank' && res.resolution.fillText
        ? res.resolution.fillText
        : res.resolution.indices
            .map((i) => String.fromCharCode(65 + i))
            .join(', ');
    showDiscreteToast(`Answer: ${label} (${res.resolution.latencyMs}ms)`, false, 3800);
  } else if (res?.error) {
    showDiscreteToast(res.error, true, 3600);
  }
}

function initializeUniversalLmsEngine(): void {
  const host = window.location.hostname.toLowerCase();
  if (isKahootHostname(host) || isWaygroundHostname(host)) {
    return;
  }
  if (window.__kheUniversalLmsInstalled) {
    return;
  }
  window.__kheUniversalLmsInstalled = true;
  window.__kheUniversalTriggerScan = runUniversalPageScan;

  void (async () => {
    currentSettings = await loadSettings();
    if (!currentSettings.enabled) {
      return;
    }
    if (currentSettings.universalHighlightEnabled) {
      const summary = await runUniversalPageScan(false);
      if (summary.detectedCount === 0 && isKnownLmsEnvironment()) {
        void sendRuntimeMessage<{ ok: boolean }>({
          type: 'WARMUP_CONNECTIONS',
        });
      }
    } else if (isKnownLmsEnvironment()) {
      void sendRuntimeMessage<{ ok: boolean }>({
        type: 'WARMUP_CONNECTIONS',
      });
    }
  })();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEYS.SETTINGS]?.newValue) {
      return;
    }
    const prevStyle = currentSettings.highlightStyle;
    const prevUniversal = currentSettings.universalHighlightEnabled;
    const prevAutoClick = currentSettings.lmsAutoClickEnabled;
    const prevAutoNext = currentSettings.lmsAutoNextPage;
    const next = changes[STORAGE_KEYS.SETTINGS].newValue as EngineSettings;
    currentSettings = next;

    if (!next.enabled || (!next.universalHighlightEnabled && !manualScanActivated)) {
      cancelScheduledAutoNext();
      clearAllVisualHighlights();
      return;
    }

    if (!next.lmsAutoNextPage) {
      cancelScheduledAutoNext();
    }

    if (prevStyle !== next.highlightStyle || prevAutoClick !== next.lmsAutoClickEnabled) {
      renderAllResolvedHighlights();
    }
    if (!prevAutoClick && next.lmsAutoClickEnabled) {
      if (resolvedBlocks.size > 0) {
        void applyAutoClickForAllResolved(false);
      } else {
        scheduleAutoEvaluation(10);
      }
    } else if (!prevAutoNext && next.lmsAutoNextPage) {
      autoNextCanceledByUser = false;
      maybeScheduleAutoNextPage();
    }
    if (!prevUniversal && next.universalHighlightEnabled) {
      scheduleAutoEvaluation(20);
    }
  });

  chrome.runtime.onMessage.addListener(
    (
      message: ContentPushMessage,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (res: { ok: boolean }) => void
    ) => {
      if (message?.type === 'PING_CONTENT_ENGINE') {
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === 'SCAN_UNIVERSAL_PAGE') {
        void runUniversalPageScan(Boolean(message.force)).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }
      if (
        message?.type === 'APPLY_ARBITER_RESOLUTION' &&
        message.stateHash &&
        message.resolution
      ) {
        const sig = stateHashToSig.get(message.stateHash);
        if (sig) {
          const existing = resolvedBlocks.get(sig);
          if (existing) {
            existing.resolution = message.resolution;
            renderAllResolvedHighlights();
            if (!userManuallyEditedSigs.has(sig)) {
              applyAutoClickToResolvedBlock(
                sig,
                existing.block,
                message.resolution,
                true
              );
            }
            maybeScheduleAutoNextPage();
          } else {
            const liveBlocks = extractUniversalQuestionBlocks(true);
            const found = liveBlocks.find(
              (b) => b.blockId === message.stateHash || b.contentSig === sig
            );
            if (found) {
              resolvedBlocks.set(found.contentSig, {
                block: found,
                resolution: message.resolution,
              });
              renderAllResolvedHighlights();
              if (!userManuallyEditedSigs.has(found.contentSig)) {
                applyAutoClickToResolvedBlock(
                  found.contentSig,
                  found,
                  message.resolution,
                  true
                );
              }
              maybeScheduleAutoNextPage();
            }
          }
        }
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === 'APPLY_RESOLVED_ANSWER' && message.resolution) {
        const blocks = extractUniversalQuestionBlocks(true);
        if (blocks.length === 1) {
          resolvedBlocks.set(blocks[0].contentSig, {
            block: blocks[0],
            resolution: message.resolution,
          });
          renderAllResolvedHighlights();
          applyAutoClickToResolvedBlock(
            blocks[0].contentSig,
            blocks[0],
            message.resolution,
            true
          );
          maybeScheduleAutoNextPage();
        } else {
          const label =
            message.resolution.questionKind === 'fill_blank' &&
            message.resolution.fillText
              ? message.resolution.fillText
              : message.resolution.indices
                  .map((i) => String.fromCharCode(65 + i))
                  .join(', ');
          showDiscreteToast(`Answer: ${label}`, false, 3800);
        }
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === 'CLIPBOARD_STATUS_TOAST' && message.message) {
        showDiscreteToast(message.message, Boolean(message.isError));
        sendResponse({ ok: true });
        return false;
      }
      return false;
    }
  );

  document.addEventListener(
    'change',
    (event: Event) => {
      if (programmaticActionActive || !event.isTrusted) {
        return;
      }
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      cancelScheduledAutoNext();
      for (const [sig, rec] of resolvedBlocks.entries()) {
        if (rec.block.container.contains(target)) {
          userManuallyEditedSigs.add(sig);
        }
      }
    },
    true
  );

  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        autoNextCanceledByUser = true;
        cancelScheduledAutoNext();
        return;
      }
      if (event.altKey && event.shiftKey && event.code === 'KeyS') {
        event.preventDefault();
        void runUniversalPageScan(true);
      }
    },
    true
  );

  window.addEventListener('paste', (event: ClipboardEvent) => {
    void handleImagePasteOnExternalPage(event);
  });

  window.addEventListener(
    'scroll',
    () => {
      if (
        !currentSettings.enabled ||
        (!currentSettings.universalHighlightEnabled && !manualScanActivated)
      ) {
        return;
      }
      if (scrollDebounceTimer !== null) {
        clearTimeout(scrollDebounceTimer);
      }
      scrollDebounceTimer = setTimeout(() => {
        scrollDebounceTimer = null;
        if (resolvedBlocks.size > 0 || manualScanActivated) {
          void runUniversalPageScan(false);
        }
      }, 320);
    },
    { passive: true }
  );

  const observer = new MutationObserver((mutations) => {
    if (!chrome.runtime?.id) {
      observer.disconnect();
      cancelScheduledAutoNext();
      clearAllVisualHighlights();
      return;
    }
    if (
      programmaticActionActive ||
      !currentSettings.enabled ||
      (!currentSettings.universalHighlightEnabled && !manualScanActivated)
    ) {
      return;
    }
    let hasRelevantQuestionMutation = false;
    for (const m of mutations) {
      if (m.type === 'childList' && m.addedNodes.length > 0) {
        for (const node of Array.from(m.addedNodes)) {
          if (!(node instanceof HTMLElement)) {
            continue;
          }
          if (
            node.hasAttribute('data-khe-lms-badge') ||
            node.classList.contains('khe-stealth-mark') ||
            node.closest('#quiz-timer, [id*="timer"], .timer')
          ) {
            continue;
          }
          if (
            node.matches(
              'div.que, input, select, textarea, [role="radio"], [role="checkbox"], [role="listitem"], [data-automation-id="questionItem"], [class*="question"]'
            ) ||
            node.querySelector(
              'div.que, input[type="radio"], input[type="checkbox"], select, [role="radio"], [role="checkbox"], [data-automation-id="questionItem"]'
            ) !== null
          ) {
            hasRelevantQuestionMutation = true;
            break;
          }
        }
      }
      if (hasRelevantQuestionMutation) {
        break;
      }
    }
    if (hasRelevantQuestionMutation) {
      scheduleAutoEvaluation(90);
    }
  });

  const attach = (): void => {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
      });
    }
  };

  if (document.body) {
    attach();
  } else {
    document.addEventListener('DOMContentLoaded', attach, { once: true });
  }
}

initializeUniversalLmsEngine();
