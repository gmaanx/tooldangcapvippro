import {
  BRIDGE_SOURCE,
  DEFAULT_QUESTION_TIMER_MS,
  DEFAULT_SETTINGS,
  HIGHLIGHT_OUTLINE_CSS,
  ISOLATED_BRIDGE_SOURCE,
  SELECTORS,
  STORAGE_KEYS,
  VISION_MAX_DIMENSION_PX,
  VISION_WEBP_QUALITY,
  WAYGROUND_SELECTORS,
} from '../shared/constants';
import {
  buildContentSignature,
  buildQuestionStateHash,
  computeTargetScoreDelayMs,
  isKahootHostname,
  isWaygroundHostname,
  snapCountdownSecondsToTimerMs,
} from '../shared/normalize';
import { loadSettings } from '../shared/storage';
import type {
  AnswerResolution,
  ClipboardExtractedPayload,
  ContentPushMessage,
  EngineSettings,
  IsolatedToMainClickEnvelope,
  MainWorldBridgeEnvelope,
  QuestionPayload,
  QuizPlatform,
  RuntimeClickResponse,
  RuntimeRequestMessage,
  RuntimeResolveResponse,
  TriggerMode,
  WsQuestionSignal,
} from '../shared/types';

declare global {
  interface Window {
    __kahootHybridIsolatedInstalled?: boolean;
  }
}

const IS_WAYGROUND = isWaygroundHostname(window.location.hostname);
const PLATFORM: QuizPlatform = IS_WAYGROUND ? 'wayground' : 'kahoot';

let currentSettings: EngineSettings = { ...DEFAULT_SETTINGS };
let currentQuestionIndex = -1;
let syntheticRoundCounter = 0;
let buttonsMounted = false;
let activeDomRoundSignature: string | null = null;
let readyButtonsPerfTimestamp = 0;
let currentQuestionTimerMs = DEFAULT_QUESTION_TIMER_MS;
let wsTimerCapturedForRound = false;
let lastScheduledWaitMs = 0;
let domEvalTimer: ReturnType<typeof setTimeout> | null = null;
let lastObservedHref = '';

let pendingResolution: AnswerResolution | null = null;
let activeRoundResolution: AnswerResolution | null = null;
let lastRoundQuestionContext: {
  questionText: string;
  options: string[];
} | null = null;
let pendingCommitAttempts = 0;
let highlightedStateHash: string | null = null;
let clickedStateHash: string | null = null;
let shownDebuggerWarningHash: string | null = null;
let scheduledJitterTimer: ReturnType<typeof setTimeout> | null = null;
let hostOnlySettleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingCommitRetryTimer: ReturnType<typeof setTimeout> | null = null;
let clickVerifyTimer: ReturnType<typeof setTimeout> | null = null;
let clickVerifyAttempts = 0;
let hudToastHost: HTMLElement | null = null;
let hudToastTextEl: HTMLElement | null = null;
let hudToastTimer: ReturnType<typeof setTimeout> | null = null;
let domObserver: MutationObserver | null = null;

const triggeredStateHashes = new Set<string>();
const triggeredContentSignatures = new Set<string>();
const triggeredVisionRounds = new Set<number>();
const broadcastedHostSignatures = new Set<string>();
const appliedBroadcastHashes = new Set<string>();

function syncWaygroundFocusGuardAttribute(): void {
  if (!IS_WAYGROUND || !document.documentElement) {
    return;
  }
  const desired =
    currentSettings.enabled && currentSettings.antiFocusLoss ? '1' : '0';
  if (
    document.documentElement.getAttribute('data-hybrid-focus-guard') !== desired
  ) {
    document.documentElement.setAttribute('data-hybrid-focus-guard', desired);
  }
}

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

function clearClickVerifyTimer(): void {
  if (clickVerifyTimer !== null) {
    clearTimeout(clickVerifyTimer);
    clickVerifyTimer = null;
  }
  clickVerifyAttempts = 0;
}

function clearScheduledTimers(): void {
  if (domEvalTimer !== null) {
    clearTimeout(domEvalTimer);
    domEvalTimer = null;
  }
  if (scheduledJitterTimer !== null) {
    clearTimeout(scheduledJitterTimer);
    scheduledJitterTimer = null;
  }
  if (hostOnlySettleTimer !== null) {
    clearTimeout(hostOnlySettleTimer);
    hostOnlySettleTimer = null;
  }
  if (pendingCommitRetryTimer !== null) {
    clearTimeout(pendingCommitRetryTimer);
    pendingCommitRetryTimer = null;
  }
  clearClickVerifyTimer();
}

function resetPerRoundDomState(): void {
  readyButtonsPerfTimestamp = 0;
  currentQuestionTimerMs = DEFAULT_QUESTION_TIMER_MS;
  wsTimerCapturedForRound = false;
  lastScheduledWaitMs = 0;
  pendingResolution = null;
  activeRoundResolution = null;
  pendingCommitAttempts = 0;
  highlightedStateHash = null;
  clickedStateHash = null;
  clearClickVerifyTimer();
  if (scheduledJitterTimer !== null) {
    clearTimeout(scheduledJitterTimer);
    scheduledJitterTimer = null;
  }
  if (pendingCommitRetryTimer !== null) {
    clearTimeout(pendingCommitRetryTimer);
    pendingCommitRetryTimer = null;
  }
}

function resetSessionDeduplication(): void {
  triggeredStateHashes.clear();
  triggeredContentSignatures.clear();
  triggeredVisionRounds.clear();
  broadcastedHostSignatures.clear();
  appliedBroadcastHashes.clear();
  currentQuestionIndex = -1;
  syntheticRoundCounter = 0;
  activeDomRoundSignature = null;
  lastRoundQuestionContext = null;
  shownDebuggerWarningHash = null;
  resetPerRoundDomState();
  clearScheduledTimers();
}

function isActiveWaygroundQuestionRoute(): boolean {
  const pathname = window.location.pathname.toLowerCase();
  if (
    pathname === '/' ||
    pathname === '/join' ||
    pathname === '/join/' ||
    pathname.startsWith('/join/pre-game') ||
    pathname.startsWith('/join/lobby') ||
    pathname.startsWith('/join/game-over') ||
    pathname.startsWith('/join/summary') ||
    pathname.startsWith('/join/results') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/signup')
  ) {
    return false;
  }
  return true;
}

function extractIndexedAttributeNumber(rawAttr: string): number | null {
  const answerMatch = rawAttr.match(/^answer-(\d+)$/);
  if (answerMatch) {
    return Number.parseInt(answerMatch[1], 10);
  }
  const choiceMatch = rawAttr.match(/^question-choice-(\d+)$/);
  if (choiceMatch) {
    return Number.parseInt(choiceMatch[1], 10);
  }
  return null;
}

function getVisibleAnswerButtons(): HTMLElement[] {
  if (IS_WAYGROUND) {
    if (!isActiveWaygroundQuestionRoute()) {
      return [];
    }
    const indexed = new Map<number, HTMLElement>();
    for (let i = 0; i < 8; i += 1) {
      const nodes = Array.from(
        document.querySelectorAll<HTMLElement>(
          WAYGROUND_SELECTORS.INDEXED_OPTION(i)
        )
      );
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 8 || rect.height <= 8) {
          continue;
        }
        const existing = indexed.get(i);
        const testId = node.getAttribute('data-testid') ?? '';
        if (!existing || testId.startsWith('option-trigger-')) {
          indexed.set(i, node);
        }
      }
    }
    if (indexed.size >= 2) {
      return Array.from(indexed.entries())
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1]);
    }

    const rawCandidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        WAYGROUND_SELECTORS.ALL_OPTION_CANDIDATES
      )
    );
    const deduped: HTMLElement[] = [];
    for (const el of rawCandidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 12 || rect.height <= 12) {
        continue;
      }
      if (deduped.some((prev) => prev.contains(el) || el.contains(prev))) {
        continue;
      }
      deduped.push(el);
    }
    return deduped.length >= 2 ? deduped.slice(0, 8) : [];
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(SELECTORS.ANSWER_PREFIX)
  );
  const byIndex = new Map<number, HTMLElement>();

  for (const el of candidates) {
    const selectorAttr = el.getAttribute('data-functional-selector') ?? '';
    const parsedIdx = extractIndexedAttributeNumber(selectorAttr);
    if (parsedIdx === null) {
      continue;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 4 || rect.height <= 4) {
      continue;
    }
    const existing = byIndex.get(parsedIdx);
    if (!existing || selectorAttr.startsWith('answer-')) {
      byIndex.set(parsedIdx, el);
    }
  }

  return Array.from(byIndex.entries())
    .sort((a, b) => a[0] - b[0])
    .map((entry) => entry[1]);
}

function findVisibleAnswerButton(index: number): HTMLElement | null {
  if (IS_WAYGROUND) {
    return getVisibleAnswerButtons()[index] ?? null;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(SELECTORS.ANSWER_BY_INDEX(index))
  );
  let fallback: HTMLElement | null = null;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 4 || rect.height <= 4) {
      continue;
    }
    const attr = el.getAttribute('data-functional-selector') ?? '';
    if (attr === `answer-${index}`) {
      return el;
    }
    if (!fallback) {
      fallback = el;
    }
  }
  return fallback;
}

function getVisibleBlankInputs(): Array<HTMLInputElement | HTMLTextAreaElement> {
  if (!IS_WAYGROUND || !isActiveWaygroundQuestionRoute()) {
    return [];
  }

  const direct = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      WAYGROUND_SELECTORS.BLANK_INPUTS
    )
  ).filter((el) => {
    if (el.disabled || el.readOnly) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  });

  if (direct.length > 0) {
    return direct;
  }

  const stemEl = document.querySelector<HTMLElement>(
    WAYGROUND_SELECTORS.QUESTION_TITLE
  );
  if (!stemEl) {
    return [];
  }
  const stemRect = stemEl.getBoundingClientRect();
  if (stemRect.width <= 20 || stemRect.height <= 10) {
    return [];
  }

  return Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      'input[type="text"]:not([readonly]), textarea:not([readonly])'
    )
  ).filter((el) => {
    if (el.disabled) {
      return false;
    }
    const r = el.getBoundingClientRect();
    if (r.width <= 14 || r.height <= 14) {
      return false;
    }
    const meta = `${el.placeholder || ''} ${el.name || ''} ${el.id || ''}`.toLowerCase();
    if (
      meta.includes('search') ||
      meta.includes('code') ||
      meta.includes('pin') ||
      meta.includes('name') ||
      meta.includes('nick')
    ) {
      return false;
    }
    return true;
  });
}

function detectBlankLengthHint(
  inputs: Array<HTMLInputElement | HTMLTextAreaElement>
): number | undefined {
  if (
    inputs.length > 1 &&
    inputs.every(
      (inp) =>
        inp instanceof HTMLInputElement &&
        (inp.maxLength === 1 ||
          inp.classList.contains('box-input') ||
          (inp.getAttribute('data-cy') ?? '').startsWith('box'))
    )
  ) {
    return inputs.length;
  }
  return undefined;
}

function detectQuestionStemHasImage(): boolean {
  if (!IS_WAYGROUND) {
    return false;
  }
  const imgs = Array.from(
    document.querySelectorAll<HTMLImageElement>(
      WAYGROUND_SELECTORS.QUESTION_MEDIA_IMG
    )
  );
  return imgs.some((img) => {
    const r = img.getBoundingClientRect();
    return Boolean(img.src) && r.width > 48 && r.height > 36;
  });
}

function isVisibleMultiSelectSubmitPresent(): boolean {
  if (IS_WAYGROUND) {
    const options = getVisibleAnswerButtons();
    if (options.length < 2) {
      return false;
    }
    const hasCheckboxSemantics = options.some(
      (opt) =>
        opt.getAttribute('role') === 'checkbox' ||
        opt.hasAttribute('aria-checked') ||
        opt.querySelector('[role="checkbox"], input[type="checkbox"]') !== null
    );
    if (hasCheckboxSemantics) {
      return true;
    }
    const submits = Array.from(
      document.querySelectorAll<HTMLElement>(WAYGROUND_SELECTORS.SUBMIT_BUTTON)
    );
    const hasVisibleSubmit = submits.some((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8;
    });
    if (hasVisibleSubmit) {
      return true;
    }
    return false;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(SELECTORS.MULTI_SELECT_SUBMIT)
  );
  return candidates.some((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 8 && rect.height > 8;
  });
}

function parseDomQuestionCounter(): number | null {
  const selector = IS_WAYGROUND
    ? WAYGROUND_SELECTORS.QUESTION_COUNTER
    : SELECTORS.QUESTION_COUNTER;
  const counterEl = document.querySelector<HTMLElement>(selector);
  if (!counterEl) {
    return null;
  }
  const text = counterEl.textContent?.trim() ?? '';
  const match = text.match(/(\d+)\s*(?:\/|of)\s*\d+/i) ?? text.match(/^(\d+)$/);
  if (!match) {
    return null;
  }
  const oneBased = Number.parseInt(match[1], 10);
  return Number.isFinite(oneBased) && oneBased >= 1 ? oneBased - 1 : null;
}

function detectDomQuestionTimerMs(): number | null {
  const selector = IS_WAYGROUND
    ? WAYGROUND_SELECTORS.QUESTION_TIMER
    : SELECTORS.QUESTION_TIMER;
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(selector));
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 4 || rect.height <= 4) {
      continue;
    }
    const text = (el.textContent ?? '').trim();
    const mmss = text.match(/^(\d{1,2}):(\d{2})$/);
    if (mmss) {
      const totalSec =
        Number.parseInt(mmss[1], 10) * 60 + Number.parseInt(mmss[2], 10);
      if (totalSec >= 4 && totalSec <= 240) {
        return snapCountdownSecondsToTimerMs(totalSec);
      }
    }
    const secMatch = text.match(/^(\d{1,3})s?$/i);
    if (secMatch) {
      const seconds = Number.parseInt(secMatch[1], 10);
      if (Number.isFinite(seconds) && seconds >= 4 && seconds <= 240) {
        return snapCountdownSecondsToTimerMs(seconds);
      }
    }
  }
  return null;
}

function resolveClickableButton(rawTarget: HTMLElement): HTMLElement {
  if (rawTarget.tagName.toLowerCase() === 'button') {
    return rawTarget;
  }
  const innerBtn = rawTarget.querySelector<HTMLElement>(
    'button, [role="button"], [role="option"], [role="checkbox"]'
  );
  if (innerBtn) {
    const r = innerBtn.getBoundingClientRect();
    if (r.width > 8 && r.height > 8) {
      return innerBtn;
    }
  }
  const ancestorBtn = rawTarget.closest<HTMLElement>(
    'button, [role="button"], [role="option"]'
  );
  const guardSel = IS_WAYGROUND
    ? WAYGROUND_SELECTORS.ALL_OPTION_CANDIDATES
    : SELECTORS.ANSWER_PREFIX;
  if (ancestorBtn && ancestorBtn.querySelectorAll(guardSel).length <= 1) {
    return ancestorBtn;
  }
  return rawTarget;
}

function isElementInteractive(element: HTMLElement): boolean {
  const clickable = resolveClickableButton(element);
  if (
    element.hasAttribute('disabled') ||
    clickable.hasAttribute('disabled') ||
    element.getAttribute('aria-disabled') === 'true' ||
    clickable.getAttribute('aria-disabled') === 'true'
  ) {
    return false;
  }
  const rect = clickable.getBoundingClientRect();
  if (rect.width <= 8 || rect.height <= 8) {
    return false;
  }
  const computed = window.getComputedStyle(clickable);
  return (
    computed.pointerEvents !== 'none' &&
    computed.visibility !== 'hidden' &&
    Number.parseFloat(computed.opacity || '1') > 0.15
  );
}

function extractCleanVisibleText(rootEl: HTMLElement): string {
  const clone = rootEl.cloneNode(true) as HTMLElement;

  clone.querySelectorAll('.katex').forEach((katexNode) => {
    const texAnnotation = katexNode.querySelector(
      'annotation[encoding="application/x-tex"]'
    );
    const tex = texAnnotation?.textContent?.trim();
    if (tex) {
      katexNode.replaceWith(document.createTextNode(` ${tex} `));
    }
  });

  clone.querySelectorAll('mjx-container[aria-label]').forEach((mjxNode) => {
    const label = mjxNode.getAttribute('aria-label')?.trim();
    if (label) {
      mjxNode.replaceWith(document.createTextNode(` ${label} `));
    }
  });

  clone
    .querySelectorAll('svg, style, script, noscript, [aria-hidden="true"]')
    .forEach((node) => node.remove());
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function extractOptionTextsFromDom(buttons: HTMLElement[]): string[] {
  return buttons.map((button, idx) => {
    if (!IS_WAYGROUND) {
      const dedicatedTextEl =
        button.querySelector<HTMLElement>(SELECTORS.CHOICE_TEXT_BY_INDEX(idx)) ??
        document.querySelector<HTMLElement>(SELECTORS.CHOICE_TEXT_BY_INDEX(idx));
      if (dedicatedTextEl) {
        const dedicatedClean = extractCleanVisibleText(dedicatedTextEl);
        if (dedicatedClean.length > 0) {
          return dedicatedClean;
        }
      }
    } else {
      const wgTextEl = button.querySelector<HTMLElement>(
        '[data-testid="option-text"], [data-cy="option-text"], .option-text, .resizeable-text'
      );
      if (wgTextEl) {
        const wgClean = extractCleanVisibleText(wgTextEl);
        if (wgClean.length > 0) {
          return wgClean;
        }
      }
    }
    return extractCleanVisibleText(button);
  });
}

function extractQuestionTitleFromDom(anchorNodes: HTMLElement[]): string {
  const titleSelector = IS_WAYGROUND
    ? WAYGROUND_SELECTORS.QUESTION_TITLE
    : SELECTORS.QUESTION_TITLE;
  const primaryTitleNodes = Array.from(
    document.querySelectorAll<HTMLElement>(titleSelector)
  );
  for (const node of primaryTitleNodes) {
    const r = node.getBoundingClientRect();
    if (r.width <= 8 || r.height <= 6) {
      continue;
    }
    const cleanPrimary = extractCleanVisibleText(node);
    if (cleanPrimary.length > 0) {
      return cleanPrimary;
    }
  }

  if (anchorNodes.length === 0) {
    return '';
  }

  const firstAnchorTop = anchorNodes[0].getBoundingClientRect().top;
  const headingCandidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'h1, h2, [role="heading"], [data-functional-selector*="question"], [data-testid*="question"]'
    )
  );

  for (const candidate of headingCandidates) {
    if (
      anchorNodes.some(
        (node) => node.contains(candidate) || candidate.contains(node)
      )
    ) {
      continue;
    }
    const rect = candidate.getBoundingClientRect();
    if (rect.width <= 10 || rect.height <= 8) {
      continue;
    }
    if (rect.bottom > firstAnchorTop + 40) {
      continue;
    }
    const text = extractCleanVisibleText(candidate);
    if (
      text.length >= 3 &&
      !/^\d+\s*(?:\/|of)\s*\d+$/i.test(text) &&
      !/^\d+$/.test(text)
    ) {
      return text;
    }
  }

  return '';
}

function extractHostChoiceTexts(): string[] {
  const choiceNodes = Array.from(
    document.querySelectorAll<HTMLElement>(SELECTORS.HOST_CHOICE_TEXT_ALL)
  );
  const byIdx = new Map<number, string>();

  for (const node of choiceNodes) {
    const attr = node.getAttribute('data-functional-selector') ?? '';
    const match = attr.match(/(\d+)$/);
    if (!match) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    const text = extractCleanVisibleText(node);
    if (text.length > 0) {
      byIdx.set(Number.parseInt(match[1], 10), text);
    }
  }

  return Array.from(byIdx.entries())
    .sort((a, b) => a[0] - b[0])
    .map((item) => item[1]);
}

const STEALTH_HIGHLIGHT_KEY = 'khe-stealth-answer';
const STEALTH_OUTLINE_FALLBACK = '1px dotted rgba(148, 163, 184, 0.55)';
let stealthStyleInjected = false;

function ensureStealthHighlightStylesheet(): void {
  if (stealthStyleInjected || !document.head) {
    return;
  }
  stealthStyleInjected = true;
  const styleEl = document.createElement('style');
  styleEl.setAttribute('data-khe-stealth-style', '1');
  styleEl.textContent =
    '::highlight(khe-stealth-answer){text-decoration-line:underline;text-decoration-style:dotted;text-decoration-color:rgba(148,163,184,0.72);text-decoration-thickness:1.5px;text-underline-offset:3px;}';
  document.head.appendChild(styleEl);
}

function collectElementTextRanges(root: HTMLElement): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const raw = node.nodeValue ?? '';
    const trimmed = raw.trim();
    if (trimmed.length > 0 && node.parentElement) {
      const start = raw.indexOf(trimmed);
      if (start >= 0) {
        const range = new Range();
        range.setStart(node, start);
        range.setEnd(node, start + trimmed.length);
        ranges.push(range);
      }
    }
    node = walker.nextNode();
  }
  return ranges;
}

function clearStealthCustomHighlights(): void {
  try {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS && CSS.highlights) {
      CSS.highlights.delete(STEALTH_HIGHLIGHT_KEY);
    }
  } catch {
    void 0;
  }
}

function clearAllAnswerHighlights(): void {
  clearStealthCustomHighlights();
  const buttonSel = IS_WAYGROUND
    ? WAYGROUND_SELECTORS.ALL_OPTION_CANDIDATES
    : SELECTORS.ANSWER_PREFIX;
  document.querySelectorAll<HTMLElement>(buttonSel).forEach((btn) => {
    if (btn.style.outline) {
      btn.style.outline = '';
      btn.style.outlineOffset = '';
    }
  });

  if (IS_WAYGROUND) {
    document
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        WAYGROUND_SELECTORS.BLANK_INPUTS + ', input[data-hybrid-orig-ph]'
      )
      .forEach((inp) => {
        if (inp.style.outline) {
          inp.style.outline = '';
          inp.style.outlineOffset = '';
        }
        const origPh = inp.getAttribute('data-hybrid-orig-ph');
        if (origPh !== null) {
          inp.placeholder = origPh;
          inp.removeAttribute('data-hybrid-orig-ph');
        }
      });
  }
}

function applyHighlightToTargets(indices: number[]): boolean {
  const wantedButtons = new Set<HTMLElement>();
  for (const targetIndex of indices) {
    const targetButton = findVisibleAnswerButton(targetIndex);
    if (targetButton) {
      wantedButtons.add(targetButton);
    }
  }

  const allButtons = IS_WAYGROUND
    ? getVisibleAnswerButtons()
    : Array.from(document.querySelectorAll<HTMLElement>(SELECTORS.ANSWER_PREFIX));

  const useStealth = currentSettings.highlightStyle === 'stealth';
  clearStealthCustomHighlights();

  allButtons.forEach((btn) => {
    if ((!wantedButtons.has(btn) || useStealth) && btn.style.outline) {
      btn.style.outline = '';
      btn.style.outlineOffset = '';
    }
  });

  if (useStealth) {
    ensureStealthHighlightStylesheet();
    const supportsCustomHighlights =
      typeof CSS !== 'undefined' &&
      'highlights' in CSS &&
      Boolean(CSS.highlights) &&
      typeof Highlight !== 'undefined';
    const textRanges: Range[] = [];

    for (const targetButton of wantedButtons) {
      const btnRanges = supportsCustomHighlights
        ? collectElementTextRanges(targetButton)
        : [];
      if (btnRanges.length > 0) {
        textRanges.push(...btnRanges);
      } else {
        targetButton.style.outline = STEALTH_OUTLINE_FALLBACK;
        targetButton.style.outlineOffset = '-1px';
      }
    }

    if (supportsCustomHighlights && textRanges.length > 0) {
      CSS.highlights.set(STEALTH_HIGHLIGHT_KEY, new Highlight(...textRanges));
    }

    return wantedButtons.size > 0;
  }

  for (const targetButton of wantedButtons) {
    if (targetButton.style.outline !== HIGHLIGHT_OUTLINE_CSS) {
      targetButton.style.outline = HIGHLIGHT_OUTLINE_CSS;
      targetButton.style.outlineOffset = '-2px';
    }
  }

  return wantedButtons.size > 0;
}

function applyHighlightToBlankInputs(
  inputs: Array<HTMLInputElement | HTMLTextAreaElement>,
  fillText: string
): boolean {
  if (inputs.length === 0) {
    return false;
  }
  const useStealth = currentSettings.highlightStyle === 'stealth';
  const outlineCss = useStealth
    ? STEALTH_OUTLINE_FALLBACK
    : HIGHLIGHT_OUTLINE_CSS;
  for (const inp of inputs) {
    if (inp.style.outline !== outlineCss) {
      inp.style.outline = outlineCss;
      inp.style.outlineOffset = '-1px';
    }
  }
  if (inputs.length === 1 && fillText) {
    const single = inputs[0];
    if (!single.hasAttribute('data-hybrid-orig-ph')) {
      single.setAttribute('data-hybrid-orig-ph', single.placeholder || '');
    }
    const hintText = useStealth ? fillText : `Answer: ${fillText}`;
    if (single.placeholder !== hintText) {
      single.placeholder = hintText;
    }
  }
  return true;
}

function dispatchIsolatedMouseAndClick(rawTarget: HTMLElement): void {
  const target = resolveClickableButton(rawTarget);
  const initialRect = target.getBoundingClientRect();
  if (initialRect.top < 0 || initialRect.bottom > window.innerHeight) {
    try {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      void 0;
    }
  }

  const rect = target.getBoundingClientRect();
  const jitterOffsetX = (Math.random() - 0.5) * rect.width * 0.25;
  const jitterOffsetY = (Math.random() - 0.5) * rect.height * 0.25;
  const clientX = Math.min(
    window.innerWidth - 4,
    Math.max(4, Math.round(rect.left + rect.width / 2 + jitterOffsetX))
  );
  const clientY = Math.min(
    window.innerHeight - 4,
    Math.max(4, Math.round(rect.top + rect.height / 2 + jitterOffsetY))
  );
  const screenX = Math.round(window.screenX + clientX);
  const screenY = Math.round(window.screenY + clientY);

  const hitEl = document.elementFromPoint(clientX, clientY);
  const dispatchNode =
    hitEl instanceof HTMLElement &&
    (target.contains(hitEl) || rawTarget.contains(hitEl))
      ? hitEl
      : target;

  const sharedMouseInit: MouseEventInit = {
    view: window,
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    clientX,
    clientY,
    screenX,
    screenY,
  };

  try {
    dispatchNode.dispatchEvent(
      new MouseEvent('mousedown', { ...sharedMouseInit, buttons: 1, detail: 1 })
    );
    dispatchNode.dispatchEvent(
      new MouseEvent('mouseup', { ...sharedMouseInit, buttons: 0, detail: 1 })
    );
  } catch {
    void 0;
  }

  target.click();
}

function postMainWorldClickCommand(
  indices: number[],
  submitMultiSelect = false,
  fillText?: string,
  autoSubmit = true
): boolean {
  const mainBridgeVersion = document.documentElement?.getAttribute(
    'data-kahoot-hybrid-main'
  );
  if (mainBridgeVersion !== '2') {
    return false;
  }
  const command: IsolatedToMainClickEnvelope = {
    source: ISOLATED_BRIDGE_SOURCE,
    type: 'EXEC_MAIN_WORLD_CLICK',
    indices,
    submitMultiSelect,
    fillText,
    autoSubmit,
  };
  window.postMessage(command, '*');
  return true;
}

async function requestServiceWorkerTrustedClick(
  indices: number[],
  multiSelect: boolean,
  submitOnly = false,
  stateHash?: string
): Promise<void> {
  const res = await sendRuntimeMessage<RuntimeClickResponse>({
    type: 'EXEC_DIRECT_MAIN_CLICK',
    indices,
    multiSelect,
    submitOnly,
    useMouseEvents: true,
  });
  if (res && !res.ok) {
    if (res.error && stateHash && shownDebuggerWarningHash !== stateHash) {
      shownDebuggerWarningHash = stateHash;
      showHudToast(`⚡ ${res.error}`, true, 4500);
    }
    if (!multiSelect && !submitOnly && indices.length > 0) {
      const btn = findVisibleAnswerButton(indices[0]);
      if (btn && isElementInteractive(btn)) {
        postMainWorldClickCommand([indices[0]], false);
        dispatchIsolatedMouseAndClick(btn);
      }
    } else if (submitOnly) {
      postMainWorldClickCommand([], true);
    }
  }
}

async function requestServiceWorkerTrustedTextFill(
  fillText: string,
  stateHash?: string
): Promise<void> {
  const res = await sendRuntimeMessage<RuntimeClickResponse>({
    type: 'EXEC_DIRECT_TEXT_FILL',
    fillText,
    autoSubmit: true,
  });
  if (res && !res.ok) {
    if (res.error && stateHash && shownDebuggerWarningHash !== stateHash) {
      shownDebuggerWarningHash = stateHash;
      showHudToast(`⚡ ${res.error}`, true, 4500);
    }
    postMainWorldClickCommand([], false, fillText, true);
  }
}

function hasChoiceAcceptedState(element: HTMLElement): boolean {
  const clickable = resolveClickableButton(element);
  const cls = `${element.className || ''} ${clickable.className || ''}`.toLowerCase();
  if (
    element.getAttribute('aria-pressed') === 'true' ||
    clickable.getAttribute('aria-pressed') === 'true' ||
    element.getAttribute('aria-checked') === 'true' ||
    clickable.getAttribute('aria-checked') === 'true' ||
    element.getAttribute('aria-selected') === 'true' ||
    clickable.getAttribute('aria-selected') === 'true' ||
    element.getAttribute('data-selected') === 'true' ||
    clickable.getAttribute('data-selected') === 'true' ||
    /\bselected\b/.test(cls)
  ) {
    return true;
  }
  const postSel = IS_WAYGROUND
    ? WAYGROUND_SELECTORS.POST_SUBMIT_INDICATORS
    : SELECTORS.POST_SUBMIT_INDICATORS;
  return document.querySelector(postSel) !== null;
}

function startSingleSelectVerificationLoop(resolution: AnswerResolution): void {
  clearClickVerifyTimer();
  const targetIdx = resolution.indices[0] ?? 0;

  const verifyStep = (): void => {
    clickVerifyTimer = null;
    if (
      !currentSettings.enabled ||
      currentSettings.triggerMode === 'highlight_only' ||
      activeRoundResolution?.stateHash !== resolution.stateHash
    ) {
      return;
    }

    const visibleButtons = getVisibleAnswerButtons();
    if (visibleButtons.length === 0) {
      return;
    }

    const targetBtn = findVisibleAnswerButton(targetIdx);
    if (
      !targetBtn ||
      !isElementInteractive(targetBtn) ||
      hasChoiceAcceptedState(targetBtn)
    ) {
      return;
    }

    if (clickVerifyAttempts >= (IS_WAYGROUND ? 12 : 100)) {
      return;
    }

    clickVerifyAttempts += 1;
    applyHighlightToTargets(resolution.indices);
    void requestServiceWorkerTrustedClick(
      [targetIdx],
      false,
      false,
      resolution.stateHash
    );

    clickVerifyTimer = setTimeout(verifyStep, 240);
  };

  clickVerifyTimer = setTimeout(verifyStep, 240);
}

function startMultiSelectSubmitVerification(resolution: AnswerResolution): void {
  clearClickVerifyTimer();

  const verifySubmitStep = (): void => {
    clickVerifyTimer = null;
    if (
      !currentSettings.enabled ||
      currentSettings.triggerMode === 'highlight_only' ||
      activeRoundResolution?.stateHash !== resolution.stateHash
    ) {
      return;
    }

    const postSel = IS_WAYGROUND
      ? WAYGROUND_SELECTORS.POST_SUBMIT_INDICATORS
      : SELECTORS.POST_SUBMIT_INDICATORS;

    if (
      !isVisibleMultiSelectSubmitPresent() ||
      document.querySelector(postSel) !== null
    ) {
      return;
    }

    if (clickVerifyAttempts >= 25) {
      return;
    }

    clickVerifyAttempts += 1;
    void requestServiceWorkerTrustedClick(
      [],
      true,
      true,
      resolution.stateHash
    );
    clickVerifyTimer = setTimeout(verifySubmitStep, 250);
  };

  clickVerifyTimer = setTimeout(verifySubmitStep, 250);
}

function executeAutoFillSequence(resolution: AnswerResolution): boolean {
  const fillText = (resolution.fillText ?? '').trim();
  if (!fillText) {
    return false;
  }
  const blankInputs = getVisibleBlankInputs();
  if (blankInputs.length === 0) {
    return false;
  }

  void requestServiceWorkerTrustedTextFill(fillText, resolution.stateHash);

  clearClickVerifyTimer();
  clickVerifyTimer = setTimeout(() => {
    clickVerifyTimer = null;
    if (
      !currentSettings.enabled ||
      currentSettings.triggerMode === 'highlight_only' ||
      activeRoundResolution?.stateHash !== resolution.stateHash
    ) {
      return;
    }
    const recheck = getVisibleBlankInputs();
    if (
      recheck.length > 0 &&
      recheck.every((inp) => inp.value.trim().length === 0)
    ) {
      void requestServiceWorkerTrustedTextFill(fillText, resolution.stateHash);
    }
  }, 320);

  return true;
}

function executeAutoClickSequence(resolution: AnswerResolution): boolean {
  if (resolution.questionKind === 'fill_blank') {
    return executeAutoFillSequence(resolution);
  }

  const targets: HTMLElement[] = [];
  for (const idx of resolution.indices) {
    const btn = findVisibleAnswerButton(idx);
    if (!btn || !isElementInteractive(btn)) {
      return false;
    }
    targets.push(btn);
  }

  if (targets.length === 0) {
    return false;
  }

  const isMultiSelect =
    Boolean(resolution.multiSelect) ||
    resolution.indices.length > 1 ||
    isVisibleMultiSelectSubmitPresent();

  if (!isMultiSelect) {
    const targetIdx = resolution.indices[0] ?? 0;
    const clickable = resolveClickableButton(targets[0]);
    const rect = clickable.getBoundingClientRect();
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      try {
        clickable.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        void 0;
      }
    }
    void requestServiceWorkerTrustedClick(
      [targetIdx],
      false,
      false,
      resolution.stateHash
    );
    startSingleSelectVerificationLoop(resolution);
    return true;
  }

  const elapsedReady =
    readyButtonsPerfTimestamp > 0
      ? Math.max(0, performance.now() - readyButtonsPerfTimestamp)
      : 0;
  const settleWaitMs = Math.max(0, Math.round(260 - elapsedReady));

  setTimeout(() => {
    if (
      !currentSettings.enabled ||
      activeRoundResolution?.stateHash !== resolution.stateHash
    ) {
      return;
    }
    void requestServiceWorkerTrustedClick(
      resolution.indices,
      true,
      false,
      resolution.stateHash
    );
    startMultiSelectSubmitVerification(resolution);
  }, settleWaitMs);

  return true;
}

function schedulePendingCommitRetry(): void {
  if (pendingCommitRetryTimer !== null || !pendingResolution) {
    return;
  }
  if (pendingCommitAttempts >= 150) {
    return;
  }
  pendingCommitRetryTimer = setTimeout(() => {
    pendingCommitRetryTimer = null;
    if (pendingResolution) {
      pendingCommitAttempts += 1;
      tryCommitResolutionToDom(pendingResolution);
    }
  }, 100);
}

function syncSettingsFromResolution(resolution: AnswerResolution): void {
  if (resolution.highlightStyle) {
    currentSettings = {
      ...currentSettings,
      highlightStyle: resolution.highlightStyle,
    };
  }
  if (resolution.triggerMode) {
    currentSettings = {
      ...currentSettings,
      triggerMode: resolution.triggerMode,
      targetScore:
        typeof resolution.targetScore === 'number'
          ? resolution.targetScore
          : currentSettings.targetScore,
      minDelayMs:
        typeof resolution.minDelayMs === 'number'
          ? resolution.minDelayMs
          : currentSettings.minDelayMs,
      maxDelayMs:
        typeof resolution.maxDelayMs === 'number'
          ? resolution.maxDelayMs
          : currentSettings.maxDelayMs,
    };
  }
}

function tryCommitResolutionToDom(resolution: AnswerResolution): void {
  syncSettingsFromResolution(resolution);
  activeRoundResolution = resolution;
  if (!currentSettings.enabled) {
    return;
  }

  if (resolution.questionKind === 'fill_blank') {
    const blankInputs = getVisibleBlankInputs();
    if (blankInputs.length === 0) {
      pendingResolution = resolution;
      schedulePendingCommitRetry();
      return;
    }

    if (
      applyHighlightToBlankInputs(blankInputs, resolution.fillText ?? '')
    ) {
      highlightedStateHash = resolution.stateHash;
    }

    if (currentSettings.triggerMode === 'highlight_only') {
      lastScheduledWaitMs = 0;
      pendingResolution = null;
      pendingCommitAttempts = 0;
      return;
    }

    if (clickedStateHash === resolution.stateHash) {
      pendingResolution = null;
      pendingCommitAttempts = 0;
      return;
    }

    if (readyButtonsPerfTimestamp <= 0) {
      readyButtonsPerfTimestamp = performance.now();
      const domTimer = detectDomQuestionTimerMs();
      if (domTimer !== null) {
        currentQuestionTimerMs = domTimer;
      }
    }

    pendingResolution = null;
    pendingCommitAttempts = 0;

    if (currentSettings.triggerMode === 'instant_auto_click') {
      lastScheduledWaitMs = 0;
      if (executeAutoFillSequence(resolution)) {
        clickedStateHash = resolution.stateHash;
      }
      return;
    }

    if (scheduledJitterTimer !== null) {
      return;
    }

    const elapsedFill =
      readyButtonsPerfTimestamp > 0
        ? Math.max(0, performance.now() - readyButtonsPerfTimestamp)
        : 0;
    const waitFillMs =
      currentSettings.triggerMode === 'target_score'
        ? computeTargetScoreDelayMs(
            currentSettings.targetScore,
            currentQuestionTimerMs,
            elapsedFill
          )
        : Math.round(
            Math.max(
              0,
              currentSettings.minDelayMs +
                Math.random() *
                  Math.max(
                    0,
                    currentSettings.maxDelayMs - currentSettings.minDelayMs
                  ) -
                elapsedFill
            )
          );

    lastScheduledWaitMs = waitFillMs;
    if (waitFillMs <= 15) {
      if (executeAutoFillSequence(resolution)) {
        clickedStateHash = resolution.stateHash;
      }
      return;
    }

    scheduledJitterTimer = setTimeout(() => {
      scheduledJitterTimer = null;
      if (!currentSettings.enabled || clickedStateHash === resolution.stateHash) {
        return;
      }
      if (executeAutoFillSequence(resolution)) {
        clickedStateHash = resolution.stateHash;
      }
    }, waitFillMs);
    return;
  }

  const buttons = getVisibleAnswerButtons();
  if (buttons.length === 0) {
    pendingResolution = resolution;
    schedulePendingCommitRetry();
    return;
  }

  const highlighted = applyHighlightToTargets(resolution.indices);
  if (highlighted) {
    highlightedStateHash = resolution.stateHash;
  }

  if (currentSettings.triggerMode === 'highlight_only') {
    lastScheduledWaitMs = 0;
    pendingResolution = null;
    pendingCommitAttempts = 0;
    return;
  }

  if (clickedStateHash === resolution.stateHash) {
    pendingResolution = null;
    pendingCommitAttempts = 0;
    return;
  }

  const firstTarget = findVisibleAnswerButton(resolution.indices[0] ?? 0);
  if (!firstTarget || !isElementInteractive(firstTarget)) {
    pendingResolution = resolution;
    schedulePendingCommitRetry();
    return;
  }

  if (readyButtonsPerfTimestamp <= 0) {
    readyButtonsPerfTimestamp = performance.now();
    if (!wsTimerCapturedForRound) {
      const domTimer = detectDomQuestionTimerMs();
      if (domTimer !== null) {
        currentQuestionTimerMs = domTimer;
      }
    }
  }

  pendingResolution = null;
  pendingCommitAttempts = 0;

  if (currentSettings.triggerMode === 'instant_auto_click') {
    lastScheduledWaitMs = 0;
    if (executeAutoClickSequence(resolution)) {
      clickedStateHash = resolution.stateHash;
    }
    return;
  }

  if (scheduledJitterTimer !== null) {
    return;
  }

  const elapsedSinceReady =
    readyButtonsPerfTimestamp > 0
      ? Math.max(0, performance.now() - readyButtonsPerfTimestamp)
      : 0;

  let waitMs = 0;
  if (currentSettings.triggerMode === 'target_score') {
    waitMs = computeTargetScoreDelayMs(
      currentSettings.targetScore,
      currentQuestionTimerMs,
      elapsedSinceReady
    );
  } else {
    const minDelay = Math.max(0, currentSettings.minDelayMs);
    const maxDelay = Math.max(minDelay, currentSettings.maxDelayMs);
    const sampledJitterMs =
      minDelay + Math.random() * Math.max(0, maxDelay - minDelay);
    waitMs = Math.round(Math.max(0, sampledJitterMs - elapsedSinceReady));
  }

  lastScheduledWaitMs = waitMs;

  if (waitMs <= 15) {
    if (executeAutoClickSequence(resolution)) {
      clickedStateHash = resolution.stateHash;
    }
    return;
  }

  scheduledJitterTimer = setTimeout(() => {
    scheduledJitterTimer = null;
    if (!currentSettings.enabled || clickedStateHash === resolution.stateHash) {
      return;
    }
    if (executeAutoClickSequence(resolution)) {
      clickedStateHash = resolution.stateHash;
    } else {
      pendingResolution = resolution;
      schedulePendingCommitRetry();
    }
  }, waitMs);
}

function formatModeLabel(mode: TriggerMode | undefined): string {
  const effective = mode ?? currentSettings.triggerMode;
  if (effective === 'instant_auto_click') {
    return 'Auto-Click';
  }
  if (effective === 'target_score') {
    return `~${currentSettings.targetScore}pts`;
  }
  if (effective === 'smart_human_jitter') {
    return 'Jitter';
  }
  return 'Highlight';
}

function formatResolutionHudToast(
  res: AnswerResolution,
  prefix?: string
): string {
  const voteBadge = res.voteSummary ? ` · Vote ${res.voteSummary}` : '';
  const effectiveMode = res.triggerMode ?? currentSettings.triggerMode;
  const label = prefix
    ? `${prefix} (${formatModeLabel(effectiveMode)})`
    : formatModeLabel(effectiveMode);

  const answerDisplay =
    res.questionKind === 'fill_blank' && res.fillText
      ? `"${res.fillText.length > 28 ? res.fillText.slice(0, 28) + '…' : res.fillText}"`
      : `[${res.indices.join(', ')}]`;

  if (effectiveMode === 'target_score' && lastScheduledWaitMs > 20) {
    return `⚡ ${label} → ${answerDisplay} (click ${(lastScheduledWaitMs / 1000).toFixed(1)}s${voteBadge})`;
  }
  return `⚡ ${label} → ${answerDisplay} (${res.latencyMs}ms${voteBadge})`;
}

function showHudToast(message: string, isError = false, durationMs = 2600): void {
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
    hudToastHost.style.top = '12px';
    hudToastHost.style.zIndex = '2147483647';
    hudToastHost.style.pointerEvents = 'none';

    const shadow = hudToastHost.attachShadow({ mode: 'closed' });
    const pill = document.createElement('div');
    pill.style.padding = '7px 12px';
    pill.style.borderRadius = '8px';
    pill.style.fontFamily = 'system-ui, -apple-system, sans-serif';
    pill.style.fontSize = '12px';
    pill.style.fontWeight = '600';
    pill.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.28)';
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
    : '1px solid rgba(255, 215, 0, 0.55)';
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

async function dispatchResolutionRequest(
  payload: QuestionPayload,
  contentSig: string
): Promise<void> {
  if (payload.questionText.trim().length > 0) {
    lastRoundQuestionContext = {
      questionText: payload.questionText,
      options: payload.options,
    };
  }

  const response = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'RESOLVE_QUESTION',
    payload,
  });

  if (response && response.ok && response.resolution) {
    const res = response.resolution;
    tryCommitResolutionToDom(res);
    showHudToast(formatResolutionHudToast(res));
    return;
  }

  setTimeout(() => {
    triggeredContentSignatures.delete(contentSig);
    triggeredStateHashes.delete(payload.stateHash);
  }, 2500);

  if (response?.hostOnlyBlank) {
    showHudToast(
      '⚡ Host-Only (ẩn đề): Win+Shift+S chụp đề → Alt+Shift+V hoặc Ctrl+V',
      false,
      4200
    );
  } else if (response?.error) {
    showHudToast(`⚡ ${response.error}`, true, 4000);
  }
}

async function dispatchHostBroadcastOrVisionFallback(
  roundIndex: number,
  optionCount: number,
  multiSelect: boolean
): Promise<void> {
  if (triggeredVisionRounds.has(roundIndex)) {
    return;
  }
  triggeredVisionRounds.add(roundIndex);

  if (!IS_WAYGROUND) {
    const broadcastCheck = await sendRuntimeMessage<RuntimeResolveResponse>({
      type: 'QUERY_HOST_BROADCAST',
    });
    if (
      broadcastCheck &&
      broadcastCheck.ok &&
      broadcastCheck.resolution &&
      !appliedBroadcastHashes.has(broadcastCheck.resolution.stateHash)
    ) {
      const res = broadcastCheck.resolution;
      appliedBroadcastHashes.add(res.stateHash);
      tryCommitResolutionToDom(res);
      showHudToast(formatResolutionHudToast(res, 'Synced'));
      return;
    }
  }

  if (
    !currentSettings.geminiApiKey &&
    !currentSettings.groqApiKey &&
    !currentSettings.openRouterApiKey
  ) {
    setTimeout(() => {
      triggeredVisionRounds.delete(roundIndex);
    }, 2500);
    showHudToast(
      '⚡ Chưa lưu API Key! Mở Popup ⚡ nhập API Key rồi bấm Save.',
      true,
      4500
    );
    return;
  }

  const stateHash = buildQuestionStateHash(
    roundIndex,
    `host-only-round-${roundIndex}`,
    [],
    'vision'
  );

  const response = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'TRIGGER_VISION_FALLBACK',
    stateHash,
    questionIndex: roundIndex,
    optionCount,
    multiSelect,
  });

  if (response && response.ok && response.resolution) {
    const res = response.resolution;
    tryCommitResolutionToDom(res);
    showHudToast(formatResolutionHudToast(res, 'Vision'));
    return;
  }

  if (response?.hostOnlyBlank) {
    showHudToast(
      '⚡ Host-Only (ẩn đề): Win+Shift+S chụp đề → bấm Alt+Shift+V hoặc Ctrl+V',
      false,
      4500
    );
  } else if (response?.error) {
    showHudToast(`⚡ ${response.error}`, true, 3800);
  }
}

async function tryBroadcastHostScreenQuestion(): Promise<void> {
  if (window.location.hostname !== 'play.kahoot.it') {
    return;
  }
  const titleEl = document.querySelector<HTMLElement>(SELECTORS.QUESTION_TITLE);
  const questionText = titleEl ? extractCleanVisibleText(titleEl) : '';
  if (!questionText) {
    return;
  }

  const hostChoices = extractHostChoiceTexts();
  if (hostChoices.length < 2) {
    return;
  }

  const contentSig = buildContentSignature(questionText, hostChoices);
  if (broadcastedHostSignatures.has(contentSig)) {
    return;
  }
  broadcastedHostSignatures.add(contentSig);

  lastRoundQuestionContext = {
    questionText,
    options: hostChoices,
  };

  const domCounter = parseDomQuestionCounter() ?? syntheticRoundCounter;
  const stateHash = buildQuestionStateHash(
    domCounter,
    questionText,
    hostChoices,
    'text'
  );

  const res = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'BROADCAST_HOST_QUESTION',
    payload: {
      stateHash,
      questionIndex: domCounter,
      questionText,
      options: hostChoices,
      multiSelect: false,
      optionCount: hostChoices.length,
      source: 'dom',
      platform: 'kahoot',
      questionKind: 'choice',
    },
  });

  if (!res || !res.ok) {
    setTimeout(() => {
      broadcastedHostSignatures.delete(contentSig);
    }, 2500);
  }
}

function handleWebSocketQuestionSignal(signal: WsQuestionSignal): void {
  if (!chrome.runtime?.id) {
    domObserver?.disconnect();
    clearScheduledTimers();
    return;
  }
  if (!currentSettings.enabled) {
    return;
  }

  if (
    typeof signal.timeAvailableMs === 'number' &&
    signal.timeAvailableMs >= 5_000
  ) {
    currentQuestionTimerMs = signal.timeAvailableMs;
    wsTimerCapturedForRound = true;
  }

  const isHostTab = window.location.hostname === 'play.kahoot.it';

  if (signal.questionIndex >= 0) {
    currentQuestionIndex = signal.questionIndex;
  }

  const effectiveIndex =
    signal.questionIndex >= 0 ? signal.questionIndex : syntheticRoundCounter;

  if (signal.hasQuestionText) {
    lastRoundQuestionContext = {
      questionText: signal.questionText,
      options: signal.options,
    };

    const contentSig = buildContentSignature(signal.questionText, signal.options);
    const stateHash = buildQuestionStateHash(
      effectiveIndex,
      signal.questionText,
      signal.options,
      'text'
    );

    if (
      triggeredContentSignatures.has(contentSig) ||
      triggeredStateHashes.has(stateHash)
    ) {
      return;
    }

    triggeredContentSignatures.add(contentSig);
    triggeredStateHashes.add(stateHash);

    const payload: QuestionPayload = {
      stateHash,
      questionIndex: effectiveIndex,
      questionText: signal.questionText,
      options: signal.options,
      multiSelect: signal.multiSelect,
      optionCount: signal.optionCount,
      source: 'websocket',
      platform: 'kahoot',
      questionKind: 'choice',
    };

    if (isHostTab && getVisibleAnswerButtons().length === 0) {
      void sendRuntimeMessage<RuntimeResolveResponse>({
        type: 'BROADCAST_HOST_QUESTION',
        payload,
      });
      return;
    }

    void dispatchResolutionRequest(payload, contentSig);
    return;
  }

  if (pendingResolution !== null) {
    tryCommitResolutionToDom(pendingResolution);
    return;
  }

  if (hostOnlySettleTimer !== null) {
    clearTimeout(hostOnlySettleTimer);
  }
  hostOnlySettleTimer = setTimeout(() => {
    hostOnlySettleTimer = null;
    const visibleButtons = getVisibleAnswerButtons();
    if (visibleButtons.length > 0 && pendingResolution === null) {
      void dispatchHostBroadcastOrVisionFallback(
        effectiveIndex,
        signal.optionCount || visibleButtons.length,
        signal.multiSelect
      );
    }
  }, 160);
}

function checkUrlNavigationAndWarmup(): void {
  const currentHref = window.location.href;
  if (currentHref === lastObservedHref) {
    return;
  }
  lastObservedHref = currentHref;

  if (
    currentHref.includes('/join/pre-game') ||
    currentHref.includes('/join/lobby') ||
    currentHref.includes('/join/game-over') ||
    currentHref.includes('/join/summary') ||
    currentHref.includes('/instructions') ||
    currentHref.includes('/v2/lobby') ||
    currentHref.includes('/gameover') ||
    (!IS_WAYGROUND && currentHref.includes('/join'))
  ) {
    resetSessionDeduplication();
  }

  if (
    currentHref.includes('play.kahoot.it/v2/lobby') ||
    currentHref.includes('kahoot.it/instructions') ||
    currentHref.includes('kahoot.it/join') ||
    currentHref.includes('kahoot.it/getready') ||
    (IS_WAYGROUND && isActiveWaygroundQuestionRoute())
  ) {
    void sendRuntimeMessage<{ ok: boolean }>({ type: 'WARMUP_CONNECTIONS' });
  }
}

function evaluateDomState(): void {
  domEvalTimer = null;
  if (!chrome.runtime?.id) {
    domObserver?.disconnect();
    clearScheduledTimers();
    return;
  }
  checkUrlNavigationAndWarmup();

  if (!currentSettings.enabled) {
    return;
  }

  const buttons = getVisibleAnswerButtons();
  const blankInputs = buttons.length === 0 ? getVisibleBlankInputs() : [];
  const hasInteractiveSurface = buttons.length > 0 || blankInputs.length > 0;

  if (!hasInteractiveSurface) {
    if (buttonsMounted) {
      buttonsMounted = false;
      activeDomRoundSignature = null;
      currentQuestionIndex = -1;
      syntheticRoundCounter += 1;
      resetPerRoundDomState();
      clearScheduledTimers();
    }
    void tryBroadcastHostScreenQuestion();
    return;
  }

  if (blankInputs.length > 0) {
    const fibQuestionText = extractQuestionTitleFromDom(blankInputs);
    const fibHasImage = detectQuestionStemHasImage();
    const blankLengthHint = detectBlankLengthHint(blankInputs);
    const liveFibSig =
      fibQuestionText.length > 0
        ? buildContentSignature(`fib::${fibQuestionText}`, [
            String(blankLengthHint ?? 0),
          ])
        : null;

    if (
      liveFibSig &&
      activeDomRoundSignature &&
      liveFibSig !== activeDomRoundSignature
    ) {
      syntheticRoundCounter += 1;
      currentQuestionIndex = parseDomQuestionCounter() ?? syntheticRoundCounter;
      resetPerRoundDomState();
      clearAllAnswerHighlights();
    }
    if (liveFibSig) {
      activeDomRoundSignature = liveFibSig;
    }

    if (!buttonsMounted) {
      buttonsMounted = true;
      currentQuestionIndex = parseDomQuestionCounter() ?? syntheticRoundCounter;
    }

    if (readyButtonsPerfTimestamp <= 0) {
      readyButtonsPerfTimestamp = performance.now();
      const domTimer = detectDomQuestionTimerMs();
      if (domTimer !== null) {
        currentQuestionTimerMs = domTimer;
      }
    }

    if (pendingResolution) {
      tryCommitResolutionToDom(pendingResolution);
      return;
    }

    if (highlightedStateHash !== null) {
      if (
        activeRoundResolution &&
        currentSettings.triggerMode !== 'highlight_only' &&
        scheduledJitterTimer === null &&
        clickedStateHash !== activeRoundResolution.stateHash
      ) {
        tryCommitResolutionToDom({
          ...activeRoundResolution,
          triggerMode: currentSettings.triggerMode,
        });
      }
      return;
    }

    if (fibQuestionText.length > 0 || fibHasImage) {
      const roundIdx =
        currentQuestionIndex >= 0 ? currentQuestionIndex : syntheticRoundCounter;
      const sigKey =
        liveFibSig ?? `fib-img-${roundIdx}-${blankInputs.length}`;
      const stateHash = buildQuestionStateHash(
        roundIdx,
        `fib::${fibQuestionText}`,
        [String(blankLengthHint ?? 0)],
        fibHasImage && !fibQuestionText ? 'vision' : 'text'
      );

      if (
        triggeredContentSignatures.has(sigKey) ||
        triggeredStateHashes.has(stateHash)
      ) {
        return;
      }
      triggeredContentSignatures.add(sigKey);
      triggeredStateHashes.add(stateHash);

      void dispatchResolutionRequest(
        {
          stateHash,
          questionIndex: roundIdx,
          questionText: fibQuestionText,
          options: [],
          multiSelect: false,
          optionCount: 0,
          source: 'dom',
          platform: PLATFORM,
          questionKind: 'fill_blank',
          blankLengthHint,
          hasQuestionImage: fibHasImage,
        },
        sigKey
      );
    }
    return;
  }

  const questionText = extractQuestionTitleFromDom(buttons);
  const rawOptionTexts = extractOptionTextsFromDom(buttons);
  const hasOptionStrings = rawOptionTexts.some((txt) => txt.length > 0);
  const liveChoiceSig =
    questionText.length > 0 && hasOptionStrings
      ? buildContentSignature(questionText, rawOptionTexts)
      : null;

  if (
    IS_WAYGROUND &&
    liveChoiceSig &&
    activeDomRoundSignature &&
    liveChoiceSig !== activeDomRoundSignature
  ) {
    syntheticRoundCounter += 1;
    currentQuestionIndex = parseDomQuestionCounter() ?? syntheticRoundCounter;
    resetPerRoundDomState();
    clearAllAnswerHighlights();
  }
  if (liveChoiceSig) {
    activeDomRoundSignature = liveChoiceSig;
  }

  if (!buttonsMounted) {
    buttonsMounted = true;
    const domCounter = parseDomQuestionCounter();
    if (domCounter !== null) {
      currentQuestionIndex = domCounter;
    } else if (currentQuestionIndex < 0) {
      currentQuestionIndex = syntheticRoundCounter;
    }
  }

  if (
    readyButtonsPerfTimestamp <= 0 &&
    buttons.some((btn) => isElementInteractive(btn))
  ) {
    readyButtonsPerfTimestamp = performance.now();
    if (!wsTimerCapturedForRound) {
      const domTimer = detectDomQuestionTimerMs();
      if (domTimer !== null) {
        currentQuestionTimerMs = domTimer;
      }
    }
  }

  if (pendingResolution) {
    if (
      pendingCommitRetryTimer === null ||
      buttons.some((btn) => isElementInteractive(btn))
    ) {
      tryCommitResolutionToDom(pendingResolution);
    }
    return;
  }

  if (highlightedStateHash !== null) {
    if (
      activeRoundResolution &&
      currentSettings.triggerMode !== 'highlight_only' &&
      scheduledJitterTimer === null &&
      clickedStateHash !== activeRoundResolution.stateHash
    ) {
      tryCommitResolutionToDom({
        ...activeRoundResolution,
        triggerMode: currentSettings.triggerMode,
      });
    }
    return;
  }

  const multiSelect = isVisibleMultiSelectSubmitPresent();
  const hasQuestionImage = detectQuestionStemHasImage();

  const roundIndex =
    currentQuestionIndex >= 0 ? currentQuestionIndex : syntheticRoundCounter;

  const effectiveOptions = hasOptionStrings
    ? rawOptionTexts
    : questionText.length > 0 && buttons.length === 2
      ? ['True', 'False']
      : [];

  if (
    (questionText.length > 0 && effectiveOptions.length >= 2) ||
    (IS_WAYGROUND && hasQuestionImage && buttons.length >= 2)
  ) {
    const contentSig = buildContentSignature(
      questionText || `wg-img-${roundIndex}`,
      effectiveOptions
    );
    const stateHash = buildQuestionStateHash(
      roundIndex,
      questionText || `wg-img-${roundIndex}`,
      effectiveOptions,
      hasQuestionImage && !questionText ? 'vision' : 'text'
    );

    if (
      triggeredContentSignatures.has(contentSig) ||
      triggeredStateHashes.has(stateHash)
    ) {
      return;
    }

    triggeredContentSignatures.add(contentSig);
    triggeredStateHashes.add(stateHash);

    void dispatchResolutionRequest(
      {
        stateHash,
        questionIndex: roundIndex,
        questionText,
        options: effectiveOptions,
        multiSelect,
        optionCount: buttons.length,
        source: 'dom',
        platform: PLATFORM,
        questionKind: 'choice',
        hasQuestionImage,
      },
      contentSig
    );
    return;
  }

  if (
    !triggeredVisionRounds.has(roundIndex) &&
    hostOnlySettleTimer === null
  ) {
    hostOnlySettleTimer = setTimeout(() => {
      hostOnlySettleTimer = null;
      const recheckButtons = getVisibleAnswerButtons();
      if (
        recheckButtons.length === 0 ||
        pendingResolution !== null ||
        highlightedStateHash !== null
      ) {
        return;
      }

      const recheckTitle = extractQuestionTitleFromDom(recheckButtons);
      const recheckOptions = extractOptionTextsFromDom(recheckButtons);
      const recheckHasOptions = recheckOptions.some((t) => t.length > 0);
      const recheckEffectiveOptions = recheckHasOptions
        ? recheckOptions
        : recheckTitle.length > 0 && recheckButtons.length === 2
          ? ['True', 'False']
          : [];

      if (recheckTitle.length > 0 && recheckEffectiveOptions.length >= 2) {
        scheduleDomEvaluation();
        return;
      }

      void dispatchHostBroadcastOrVisionFallback(
        roundIndex,
        recheckButtons.length,
        isVisibleMultiSelectSubmitPresent()
      );
    }, 130);
  }
}

function scheduleDomEvaluation(): void {
  if (domEvalTimer !== null) {
    return;
  }
  domEvalTimer = setTimeout(evaluateDomState, 20);
}

async function hydrateInitialSettings(): Promise<void> {
  currentSettings = await loadSettings();
  syncWaygroundFocusGuardAttribute();
  if (currentSettings.enabled) {
    void sendRuntimeMessage<{ ok: boolean }>({ type: 'WARMUP_CONNECTIONS' });
  }
  scheduleDomEvaluation();
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

async function compressPastedImageToWebp(
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
      const webpBlob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(
          (output) => resolve(output),
          'image/webp',
          VISION_WEBP_QUALITY
        );
      });
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

function isEditableElementFocused(target: EventTarget | null): boolean {
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

async function handleDirectPasteSolve(event: ClipboardEvent): Promise<void> {
  if (!currentSettings.enabled || isEditableElementFocused(event.target)) {
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

  const plainText = data.getData('text/plain')?.trim() ?? '';
  if (!imageFile && !plainText) {
    return;
  }

  event.preventDefault();
  showHudToast('⚡ Solving pasted clipboard...');

  let extractedPayload: ClipboardExtractedPayload;
  if (imageFile) {
    const compressed = await compressPastedImageToWebp(imageFile);
    extractedPayload = {
      kind: 'image',
      base64: compressed.base64,
      mimeType: compressed.mimeType,
    };
  } else {
    extractedPayload = {
      kind: 'text',
      text: plainText,
    };
  }

  const buttons = getVisibleAnswerButtons();
  const blankInputs = buttons.length === 0 ? getVisibleBlankInputs() : [];
  const isFill = blankInputs.length > 0;
  const stateHash = buildQuestionStateHash(
    Date.now(),
    'direct-paste-clipboard',
    [],
    'vision'
  );
  const res = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'RESOLVE_DIRECT_CLIPBOARD_PAYLOAD',
    stateHash,
    questionIndex: currentQuestionIndex,
    optionCount: buttons.length || 4,
    multiSelect: isVisibleMultiSelectSubmitPresent(),
    questionKind: isFill ? 'fill_blank' : 'choice',
    blankLengthHint: isFill ? detectBlankLengthHint(blankInputs) : undefined,
    clipboard: extractedPayload,
  });

  if (res && res.ok && res.resolution) {
    tryCommitResolutionToDom(res.resolution);
    showHudToast(formatResolutionHudToast(res.resolution, 'Clipboard'));
  } else {
    showHudToast(res?.error ?? 'Clipboard Vision failed', true);
  }
}

async function triggerShortcutClipboardSolve(): Promise<void> {
  showHudToast('⚡ Solving from Clipboard...');
  const buttons = getVisibleAnswerButtons();
  const blankInputs = buttons.length === 0 ? getVisibleBlankInputs() : [];
  const isFill = blankInputs.length > 0;
  const stateHash = buildQuestionStateHash(
    Date.now(),
    'shortcut-keydown-clipboard',
    [],
    'vision'
  );
  const res = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'TRIGGER_CLIPBOARD_VISION',
    stateHash,
    questionIndex: currentQuestionIndex,
    optionCount: buttons.length || 4,
    multiSelect: isVisibleMultiSelectSubmitPresent(),
    questionKind: isFill ? 'fill_blank' : 'choice',
    blankLengthHint: isFill ? detectBlankLengthHint(blankInputs) : undefined,
  });

  if (res && res.ok && res.resolution) {
    tryCommitResolutionToDom(res.resolution);
    showHudToast(formatResolutionHudToast(res.resolution, 'Clipboard'));
  } else {
    showHudToast(res?.error ?? 'Clipboard Vision failed', true);
  }
}

async function triggerShortcutVisionCapture(): Promise<void> {
  showHudToast('⚡ Capturing Tab Vision...');
  const buttons = getVisibleAnswerButtons();
  const blankInputs = buttons.length === 0 ? getVisibleBlankInputs() : [];
  const isFill = blankInputs.length > 0;
  const manualHash = buildQuestionStateHash(
    Date.now(),
    'shortcut-keydown-vision',
    [],
    'vision'
  );
  const res = await sendRuntimeMessage<RuntimeResolveResponse>({
    type: 'TRIGGER_VISION_FALLBACK',
    stateHash: manualHash,
    questionIndex: currentQuestionIndex,
    optionCount: buttons.length || 4,
    multiSelect: isVisibleMultiSelectSubmitPresent(),
    questionKind: isFill ? 'fill_blank' : 'choice',
    blankLengthHint: isFill ? detectBlankLengthHint(blankInputs) : undefined,
  });
  if (res && res.ok && res.resolution) {
    tryCommitResolutionToDom(res.resolution);
    showHudToast(formatResolutionHudToast(res.resolution, 'Vision'));
  } else if (res?.error) {
    showHudToast(`⚡ ${res.error}`, Boolean(!res.hostOnlyBlank));
  }
}

function initializeIsolatedContentEngine(): void {
  if (window.__kahootHybridIsolatedInstalled) {
    scheduleDomEvaluation();
    return;
  }
  window.__kahootHybridIsolatedInstalled = true;

  void hydrateInitialSettings();

  setInterval(() => {
    if (
      currentSettings.enabled &&
      document.visibilityState === 'visible' &&
      (isKahootHostname(window.location.hostname) || IS_WAYGROUND)
    ) {
      void sendRuntimeMessage<{ ok: boolean }>({ type: 'WARMUP_CONNECTIONS' });
    }
  }, 24_000);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEYS.SETTINGS]?.newValue) {
      const prevMode = currentSettings.triggerMode;
      const prevScore = currentSettings.targetScore;
      const prevStyle = currentSettings.highlightStyle;
      const next = changes[STORAGE_KEYS.SETTINGS]
        .newValue as EngineSettings;
      currentSettings = next;
      syncWaygroundFocusGuardAttribute();
      if (next.highlightStyle === 'stealth' && hudToastTextEl) {
        hudToastTextEl.style.opacity = '0';
      }
      if (!next.enabled) {
        clearScheduledTimers();
        requestAnimationFrame(clearAllAnswerHighlights);
      } else {
        if (activeRoundResolution) {
          activeRoundResolution = {
            ...activeRoundResolution,
            triggerMode: next.triggerMode,
            highlightStyle: next.highlightStyle,
            targetScore: next.targetScore,
            minDelayMs: next.minDelayMs,
            maxDelayMs: next.maxDelayMs,
          };
          if (prevStyle !== next.highlightStyle) {
            if (activeRoundResolution.questionKind === 'fill_blank') {
              applyHighlightToBlankInputs(
                getVisibleBlankInputs(),
                activeRoundResolution.fillText ?? ''
              );
            } else {
              applyHighlightToTargets(activeRoundResolution.indices);
            }
          }
          if (
            (prevMode !== next.triggerMode || prevScore !== next.targetScore) &&
            scheduledJitterTimer !== null
          ) {
            clearTimeout(scheduledJitterTimer);
            scheduledJitterTimer = null;
          }
          if (
            next.triggerMode !== 'highlight_only' &&
            clickedStateHash !== activeRoundResolution.stateHash
          ) {
            tryCommitResolutionToDom(activeRoundResolution);
          }
        }
        scheduleDomEvaluation();
      }
    }
  });

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || !event.data || typeof event.data !== 'object') {
      return;
    }
    const envelope = event.data as Partial<MainWorldBridgeEnvelope>;
    if (envelope.source !== BRIDGE_SOURCE) {
      return;
    }
    if (
      envelope.type === 'QUIZ_PAYLOAD_CAPTURED' &&
      typeof envelope.quizId === 'string' &&
      envelope.payload
    ) {
      void sendRuntimeMessage<{ ok: boolean }>({
        type: 'INGEST_QUIZ_PAYLOAD',
        quizId: envelope.quizId,
        payload: envelope.payload,
      });
      return;
    }
    if (
      envelope.type === 'QUIZ_ID_DETECTED' &&
      typeof envelope.quizId === 'string'
    ) {
      void sendRuntimeMessage<{ ok: boolean }>({
        type: 'QUIZ_ID_DETECTED',
        quizId: envelope.quizId,
      });
      return;
    }
    if (
      envelope.type === 'VERIFIED_ANSWER_REVEALED' &&
      Array.isArray(envelope.correctChoices) &&
      envelope.correctChoices.length > 0 &&
      lastRoundQuestionContext &&
      lastRoundQuestionContext.questionText.length > 0
    ) {
      void sendRuntimeMessage<{ ok: boolean }>({
        type: 'LEARN_VERIFIED_ANSWER',
        questionText: lastRoundQuestionContext.questionText,
        options: lastRoundQuestionContext.options,
        indices: envelope.correctChoices,
      });
      return;
    }
    if (envelope.type === 'WS_QUESTION_EVENT' && envelope.payload) {
      handleWebSocketQuestionSignal(envelope.payload);
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
      if (message?.type === 'APPLY_RESOLVED_ANSWER' && message.resolution) {
        appliedBroadcastHashes.add(message.resolution.stateHash);
        tryCommitResolutionToDom(message.resolution);
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === 'CLIPBOARD_STATUS_TOAST' && message.message) {
        showHudToast(message.message, Boolean(message.isError));
        sendResponse({ ok: true });
        return false;
      }
      return false;
    }
  );

  window.addEventListener('paste', (event: ClipboardEvent) => {
    void handleDirectPasteSolve(event);
  });

  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.code === 'KeyQ') {
        event.preventDefault();
        void triggerShortcutVisionCapture();
        return;
      }
      if (event.altKey && event.shiftKey && event.code === 'KeyV') {
        event.preventDefault();
        void triggerShortcutClipboardSolve();
      }
    },
    true
  );

  window.addEventListener('popstate', checkUrlNavigationAndWarmup);

  const observer = new MutationObserver(() => {
    if (!chrome.runtime?.id) {
      observer.disconnect();
      clearScheduledTimers();
      return;
    }
    scheduleDomEvaluation();
  });
  domObserver = observer;

  const attachObserver = (): void => {
    syncWaygroundFocusGuardAttribute();
    const rootNode = document.documentElement ?? document;
    observer.observe(rootNode, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        'disabled',
        'aria-disabled',
        'aria-checked',
        'class',
        'data-functional-selector',
        'data-testid',
        'data-cy',
      ],
    });
    scheduleDomEvaluation();
  };

  if (document.documentElement) {
    attachObserver();
  } else {
    document.addEventListener('DOMContentLoaded', attachObserver, {
      once: true,
    });
  }
}

initializeIsolatedContentEngine();
