import { isKahootHostname, isWaygroundHostname } from '../shared/normalize';
import type { RuntimeClickResponse } from '../shared/types';

const CDP_PROTOCOL_VERSION = '1.3';
const USER_CANCEL_COOLDOWN_MS = 8_000;
const DEDUP_CLICK_WINDOW_MS = 110;

export const SUPPORTED_TAB_URL_PATTERNS = [
  'https://kahoot.it/*',
  'https://play.kahoot.it/*',
  'https://create.kahoot.it/*',
  'https://wayground.com/*',
  'https://*.wayground.com/*',
  'https://quizizz.com/*',
  'https://*.quizizz.com/*',
  'https://joinmyquiz.com/*',
  'https://*.joinmyquiz.com/*',
];

const attachedDebuggerTabs = new Set<number>();
const attachInFlight = new Map<
  number,
  Promise<{ ok: boolean; freshlyAttached: boolean; error?: string }>
>();
const canceledByUserUntil = new Map<number, number>();
const tabClickMutex = new Map<number, Promise<RuntimeClickResponse>>();
const recentClickTimestamps = new Map<string, number>();

interface LocatedPoint {
  x: number;
  y: number;
}

interface FrameLocateResult {
  points: LocatedPoint[];
  alreadySelectedCount: number;
  crossOriginChildFrame: boolean;
  kahootIframeOffset: LocatedPoint | null;
}

interface FrameBlankLocateResult {
  boxPoints: LocatedPoint[];
  isCharGrid: boolean;
  crossOriginChildFrame: boolean;
  iframeOffset: LocatedPoint | null;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isSupportedTargetUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return (
      isKahootHostname(parsed.hostname) || isWaygroundHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export function registerDebuggerLifecycleListeners(
  onUserCanceled?: (tabId: number) => void
): void {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (typeof source.tabId === 'number') {
      attachedDebuggerTabs.delete(source.tabId);
      if (reason === 'canceled_by_user') {
        canceledByUserUntil.set(
          source.tabId,
          Date.now() + USER_CANCEL_COOLDOWN_MS
        );
        onUserCanceled?.(source.tabId);
      }
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedDebuggerTabs.delete(tabId);
    canceledByUserUntil.delete(tabId);
    tabClickMutex.delete(tabId);
  });
}

export function clearUserCanceledCooldown(tabId?: number): void {
  if (typeof tabId === 'number') {
    canceledByUserUntil.delete(tabId);
    return;
  }
  canceledByUserUntil.clear();
}

export async function detachDebuggerFromTab(tabId: number): Promise<void> {
  attachedDebuggerTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    return;
  }
}

export async function detachAllDebuggerTabs(): Promise<void> {
  const currentIds = Array.from(attachedDebuggerTabs);
  attachedDebuggerTabs.clear();
  for (const tabId of currentIds) {
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      void 0;
    }
  }
  try {
    const targets = await chrome.debugger.getTargets();
    for (const item of targets) {
      if (
        item.attached &&
        typeof item.tabId === 'number' &&
        isSupportedTargetUrl(item.url)
      ) {
        try {
          await chrome.debugger.detach({ tabId: item.tabId });
        } catch {
          void 0;
        }
      }
    }
  } catch {
    return;
  }
}

async function ensureTabDebuggerAttached(
  tabId: number
): Promise<{
  ok: boolean;
  freshlyAttached: boolean;
  canceledByUser?: boolean;
  error?: string;
}> {
  const cooldownUntil = canceledByUserUntil.get(tabId) ?? 0;
  if (Date.now() < cooldownUntil) {
    return {
      ok: false,
      freshlyAttached: false,
      canceledByUser: true,
      error:
        'Giữ nguyên thanh Debugging của Chrome ở trên cùng (đừng bấm Cancel) để Auto-Click hoạt động.',
    };
  }

  if (attachedDebuggerTabs.has(tabId)) {
    return { ok: true, freshlyAttached: false };
  }

  const pending = attachInFlight.get(tabId);
  if (pending) {
    return pending;
  }

  const task = (async (): Promise<{
    ok: boolean;
    freshlyAttached: boolean;
    error?: string;
  }> => {
    try {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
      attachedDebuggerTabs.add(tabId);
      return { ok: true, freshlyAttached: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const lower = msg.toLowerCase();
      if (lower.includes('already attached') && !lower.includes('another')) {
        attachedDebuggerTabs.add(tabId);
        return { ok: true, freshlyAttached: false };
      }
      if (lower.includes('another debugger')) {
        return {
          ok: false,
          freshlyAttached: false,
          error:
            'Đang mở F12 DevTools trên tab game! Hãy đóng F12 để Auto-Click chuột thật hoạt động.',
        };
      }
      return {
        ok: false,
        freshlyAttached: false,
        error: msg,
      };
    }
  })();

  attachInFlight.set(tabId, task);
  try {
    return await task;
  } finally {
    attachInFlight.delete(tabId);
  }
}

export function isKahootActiveGameplayUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (host === 'create.kahoot.it') {
      return true;
    }
    if (host === 'kahoot.it') {
      return (
        pathname.startsWith('/start') ||
        pathname.startsWith('/getready') ||
        pathname.startsWith('/gameblock') ||
        pathname.startsWith('/answer') ||
        pathname.startsWith('/challenge')
      );
    }
    if (isWaygroundHostname(host)) {
      return (
        pathname.startsWith('/join/game') ||
        pathname.startsWith('/join/quiz') ||
        pathname.startsWith('/attempt') ||
        pathname.startsWith('/assessment') ||
        pathname.startsWith('/player') ||
        pathname.startsWith('/embed') ||
        pathname.includes('/game/')
      );
    }
    return false;
  } catch {
    return false;
  }
}

export function isKahootLobbyOrEndUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    if (host === 'kahoot.it') {
      return (
        pathname === '/' ||
        pathname.startsWith('/join') ||
        pathname.startsWith('/instructions') ||
        pathname.startsWith('/gameover') ||
        pathname.startsWith('/ranking') ||
        pathname.startsWith('/podium') ||
        pathname.startsWith('/feedback')
      );
    }
    if (isWaygroundHostname(host)) {
      return (
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
      );
    }
    return false;
  } catch {
    return false;
  }
}

export async function preattachDebuggerToTab(tabId: number): Promise<void> {
  if (tabId < 0) {
    return;
  }
  await ensureTabDebuggerAttached(tabId);
}

export async function preattachDebuggerToKahootPlayerTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({
      url: SUPPORTED_TAB_URL_PATTERNS,
    });
    for (const tab of tabs) {
      if (typeof tab.id === 'number' && isKahootActiveGameplayUrl(tab.url)) {
        await ensureTabDebuggerAttached(tab.id);
      }
    }
  } catch {
    return;
  }
}

function locateKahootChoicePointsInFrame(
  indices: number[],
  multiSelect: boolean,
  submitOnly: boolean
): FrameLocateResult {
  const isWayground = /(?:^|\.)(?:wayground|quizizz|joinmyquiz)\.com$/i.test(
    window.location.hostname
  );
  const answerPrefixSelector =
    '[data-functional-selector^="answer-"], [data-functional-selector^="question-choice-"]:not([data-functional-selector^="question-choice-text-"])';
  const kahootSubmitSelector =
    '[data-functional-selector="multi-select-submit-button"]';
  const waygroundCandidatesSelector =
    '[data-testid^="option-trigger-"], [data-testid^="option-"]:not([data-testid*="container"]):not([data-testid*="options"]):not([data-testid*="text"]):not([data-testid*="label"]), [data-cy^="option-"]:not([data-cy*="container"]):not([data-cy*="options"]), .options-grid .option, .options-container .option, button.option, [role="option"]';
  const waygroundSubmitSelector =
    '[data-testid="msq-submit-button"], [data-testid="typed-submit-button"], [data-testid="save-button"], [data-testid*="submit-btn"], [data-testid*="submit-button"], [data-cy*="submit"], button.submit-button';

  let kahootIframeOffset: LocatedPoint | null = null;
  if (window === window.top) {
    const iframeEl = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="kahoot.it"], iframe[src*="wayground.com"], iframe[src*="quizizz.com"], iframe[src*="joinmyquiz.com"]'
    );
    if (iframeEl) {
      const ir = iframeEl.getBoundingClientRect();
      if (ir.width > 20 && ir.height > 20) {
        kahootIframeOffset = {
          x: ir.left + iframeEl.clientLeft,
          y: ir.top + iframeEl.clientTop,
        };
      }
    }
  }

  let frameOffsetX = 0;
  let frameOffsetY = 0;
  let crossOriginChildFrame = false;

  if (window !== window.top) {
    try {
      let currentWin: Window = window;
      while (currentWin !== window.top) {
        const frameEl = currentWin.frameElement as HTMLElement | null;
        if (!frameEl) {
          crossOriginChildFrame = true;
          break;
        }
        const fr = frameEl.getBoundingClientRect();
        frameOffsetX += fr.left + frameEl.clientLeft;
        frameOffsetY += fr.top + frameEl.clientTop;
        currentWin = currentWin.parent;
      }
    } catch {
      crossOriginChildFrame = true;
    }
  }

  const resolveButton = (raw: HTMLElement): HTMLElement => {
    if (raw.tagName.toLowerCase() === 'button') {
      return raw;
    }
    const inner = raw.querySelector<HTMLElement>(
      'button, [role="button"], [role="option"], [role="checkbox"]'
    );
    if (inner) {
      const r = inner.getBoundingClientRect();
      if (r.width > 8 && r.height > 8) {
        return inner;
      }
    }
    const ancestor = raw.closest<HTMLElement>(
      'button, [role="button"], [role="option"]'
    );
    const guardSelector = isWayground
      ? waygroundCandidatesSelector
      : answerPrefixSelector;
    if (ancestor && ancestor.querySelectorAll(guardSelector).length <= 1) {
      return ancestor;
    }
    return raw;
  };

  const isInteractive = (raw: HTMLElement): boolean => {
    const btn = resolveButton(raw);
    if (
      raw.hasAttribute('disabled') ||
      btn.hasAttribute('disabled') ||
      raw.getAttribute('aria-disabled') === 'true' ||
      btn.getAttribute('aria-disabled') === 'true'
    ) {
      return false;
    }
    const rect = btn.getBoundingClientRect();
    if (rect.width <= 8 || rect.height <= 8) {
      return false;
    }
    const style = window.getComputedStyle(btn);
    return (
      style.pointerEvents !== 'none' &&
      style.visibility !== 'hidden' &&
      Number.parseFloat(style.opacity || '1') > 0.15
    );
  };

  const computeClickablePoint = (raw: HTMLElement): LocatedPoint | null => {
    if (!isInteractive(raw)) {
      return null;
    }
    const btn = resolveButton(raw);
    const firstRect = btn.getBoundingClientRect();
    if (firstRect.top < 0 || firstRect.bottom > window.innerHeight) {
      try {
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } catch {
        void 0;
      }
    }

    const rect = btn.getBoundingClientRect();
    const visLeft = Math.max(4, rect.left);
    const visRight = Math.min(window.innerWidth - 4, rect.right);
    const visTop = Math.max(4, rect.top);
    const visBottom = Math.min(window.innerHeight - 4, rect.bottom);
    const visW = visRight - visLeft;
    const visH = visBottom - visTop;

    if (visW < 6 || visH < 6) {
      return null;
    }

    const jitterX = (Math.random() - 0.5) * Math.min(visW * 0.24, 22);
    const jitterY = (Math.random() - 0.5) * Math.min(visH * 0.24, 14);
    const candidates: Array<[number, number]> = [
      [visLeft + visW / 2 + jitterX, visTop + visH / 2 + jitterY],
      [visLeft + visW * 0.5, visTop + visH * 0.5],
      [visLeft + visW * 0.35, visTop + visH * 0.5],
      [visLeft + visW * 0.65, visTop + visH * 0.5],
      [visLeft + visW * 0.5, visTop + visH * 0.35],
    ];

    for (const [cx, cy] of candidates) {
      const hit = document.elementFromPoint(cx, cy);
      if (
        hit instanceof Element &&
        (btn.contains(hit) || raw.contains(hit) || hit.contains(btn))
      ) {
        return {
          x: Math.round(cx + frameOffsetX),
          y: Math.round(cy + frameOffsetY),
        };
      }
    }

    return {
      x: Math.round(visLeft + visW / 2 + frameOffsetX),
      y: Math.round(visTop + visH / 2 + frameOffsetY),
    };
  };

  const collectWaygroundOptions = (): HTMLElement[] => {
    const indexed = new Map<number, HTMLElement>();
    for (let i = 0; i < 8; i += 1) {
      const sel =
        '[data-testid="option-trigger-' +
        String(i) +
        '"], [data-testid="option-' +
        String(i) +
        '"], [data-cy="option-' +
        String(i) +
        '"]';
      const nodes = Array.from(document.querySelectorAll<HTMLElement>(sel));
      for (const node of nodes) {
        const r = node.getBoundingClientRect();
        if (r.width <= 8 || r.height <= 8) {
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
      document.querySelectorAll<HTMLElement>(waygroundCandidatesSelector)
    );
    const deduped: HTMLElement[] = [];
    for (const el of rawCandidates) {
      const r = el.getBoundingClientRect();
      if (r.width <= 12 || r.height <= 12) {
        continue;
      }
      if (deduped.some((prev) => prev.contains(el) || el.contains(prev))) {
        continue;
      }
      deduped.push(el);
    }
    return deduped;
  };

  const findChoice = (idx: number, wgList: HTMLElement[]): HTMLElement | null => {
    if (isWayground) {
      return wgList[idx] ?? null;
    }
    const selector =
      '[data-functional-selector="answer-' +
      String(idx) +
      '"], [data-functional-selector="question-choice-' +
      String(idx) +
      '"]';
    const matches = Array.from(document.querySelectorAll<HTMLElement>(selector));
    let fallback: HTMLElement | null = null;
    for (const el of matches) {
      const r = el.getBoundingClientRect();
      if (r.width <= 8 || r.height <= 8) {
        continue;
      }
      if (
        el.getAttribute('data-functional-selector') ===
        'answer-' + String(idx)
      ) {
        return el;
      }
      if (!fallback) {
        fallback = el;
      }
    }
    return fallback;
  };

  const findWaygroundSubmitFallback = (): HTMLElement[] => {
    const direct = Array.from(
      document.querySelectorAll<HTMLElement>(waygroundSubmitSelector)
    );
    if (direct.length > 0) {
      return direct;
    }
    const allButtons = Array.from(document.querySelectorAll<HTMLElement>('button'));
    return allButtons.filter((btn) => {
      const label = (btn.textContent ?? '').replace(/\s+/g, ' ').trim();
      return /^(?:submit|save|send|done|nộp|gửi|xác nhận)$/i.test(label);
    });
  };

  const points: LocatedPoint[] = [];
  let alreadySelectedCount = 0;

  if (submitOnly) {
    const submits = isWayground
      ? findWaygroundSubmitFallback()
      : Array.from(document.querySelectorAll<HTMLElement>(kahootSubmitSelector));
    for (const sub of submits) {
      const pt = computeClickablePoint(sub);
      if (pt) {
        points.push(pt);
        break;
      }
    }
    return {
      points,
      alreadySelectedCount: 0,
      crossOriginChildFrame,
      kahootIframeOffset,
    };
  }

  const wgOptions = isWayground ? collectWaygroundOptions() : [];

  for (const idx of indices) {
    const choice = findChoice(idx, wgOptions);
    if (!choice) {
      continue;
    }
    if (multiSelect) {
      const btn = resolveButton(choice);
      const cls = `${choice.className || ''} ${btn.className || ''}`.toLowerCase();
      const selected =
        choice.getAttribute('aria-checked') === 'true' ||
        btn.getAttribute('aria-checked') === 'true' ||
        choice.getAttribute('aria-pressed') === 'true' ||
        btn.getAttribute('aria-pressed') === 'true' ||
        choice.getAttribute('aria-selected') === 'true' ||
        btn.getAttribute('aria-selected') === 'true' ||
        choice.getAttribute('data-selected') === 'true' ||
        btn.getAttribute('data-selected') === 'true' ||
        /\bselected\b/.test(cls);
      if (selected) {
        alreadySelectedCount += 1;
        continue;
      }
    }
    const pt = computeClickablePoint(choice);
    if (pt) {
      points.push(pt);
    }
  }

  return {
    points,
    alreadySelectedCount,
    crossOriginChildFrame,
    kahootIframeOffset,
  };
}

function fallbackSyntheticClickInFrame(
  indices: number[],
  multiSelect: boolean,
  submitOnly: boolean
): boolean {
  const isWayground = /(?:^|\.)(?:wayground|quizizz|joinmyquiz)\.com$/i.test(
    window.location.hostname
  );
  const kahootSubmitSelector =
    '[data-functional-selector="multi-select-submit-button"]';
  const waygroundCandidatesSelector =
    '[data-testid^="option-trigger-"], [data-testid^="option-"]:not([data-testid*="container"]):not([data-testid*="options"]):not([data-testid*="text"]):not([data-testid*="label"]), [data-cy^="option-"]:not([data-cy*="container"]):not([data-cy*="options"]), .options-grid .option, .options-container .option, button.option, [role="option"]';
  const waygroundSubmitSelector =
    '[data-testid="msq-submit-button"], [data-testid="typed-submit-button"], [data-testid="save-button"], [data-testid*="submit-btn"], [data-testid*="submit-button"], [data-cy*="submit"], button.submit-button';

  const findSubmitEl = (): HTMLElement | null => {
    if (!isWayground) {
      return document.querySelector<HTMLElement>(kahootSubmitSelector);
    }
    const direct = document.querySelector<HTMLElement>(waygroundSubmitSelector);
    if (direct) {
      return direct;
    }
    const btns = Array.from(document.querySelectorAll<HTMLElement>('button'));
    return (
      btns.find((b) =>
        /^(?:submit|save|send|done|nộp|gửi|xác nhận)$/i.test(
          (b.textContent ?? '').replace(/\s+/g, ' ').trim()
        )
      ) ?? null
    );
  };

  if (submitOnly) {
    const sub = findSubmitEl();
    if (sub) {
      sub.click();
      return true;
    }
    return false;
  }

  let wgOptions: HTMLElement[] = [];
  if (isWayground) {
    const indexed = new Map<number, HTMLElement>();
    for (let i = 0; i < 8; i += 1) {
      const sel =
        '[data-testid="option-trigger-' +
        String(i) +
        '"], [data-testid="option-' +
        String(i) +
        '"], [data-cy="option-' +
        String(i) +
        '"]';
      const node = document.querySelector<HTMLElement>(sel);
      if (node) {
        const r = node.getBoundingClientRect();
        if (r.width > 8 && r.height > 8) {
          indexed.set(i, node);
        }
      }
    }
    if (indexed.size >= 2) {
      wgOptions = Array.from(indexed.entries())
        .sort((a, b) => a[0] - b[0])
        .map((e) => e[1]);
    } else {
      const raw = Array.from(
        document.querySelectorAll<HTMLElement>(waygroundCandidatesSelector)
      );
      for (const el of raw) {
        const r = el.getBoundingClientRect();
        if (r.width <= 12 || r.height <= 12) continue;
        if (wgOptions.some((prev) => prev.contains(el) || el.contains(prev))) {
          continue;
        }
        wgOptions.push(el);
      }
    }
  }

  let clicked = false;
  for (const idx of indices) {
    const el = isWayground
      ? (wgOptions[idx] ?? null)
      : document.querySelector<HTMLElement>(
          '[data-functional-selector="answer-' +
            String(idx) +
            '"], [data-functional-selector="question-choice-' +
            String(idx) +
            '"]'
        );
    if (el) {
      if (
        multiSelect &&
        (el.getAttribute('aria-checked') === 'true' ||
          el.getAttribute('aria-selected') === 'true')
      ) {
        clicked = true;
        continue;
      }
      el.click();
      clicked = true;
    }
  }
  if (multiSelect && clicked) {
    setTimeout(() => {
      findSubmitEl()?.click();
    }, 115);
  }
  return clicked;
}

function locateAndPrepareBlankInputsInFrame(): FrameBlankLocateResult {
  const blankSelector =
    'input.typed-option-input, input.box-input, input[data-cy^="box"], [data-testid*="fib-input"], [data-testid*="blank-input"], [data-testid*="typed-input"] input, .typed-answer-wrapper input, .fib-container input, [data-testid="question-container"] input[type="text"]:not([readonly]), .question-container input[type="text"]:not([readonly])';

  let iframeOffset: LocatedPoint | null = null;
  if (window === window.top) {
    const iframeEl = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="wayground.com"], iframe[src*="quizizz.com"], iframe[src*="joinmyquiz.com"], iframe[src*="kahoot.it"]'
    );
    if (iframeEl) {
      const ir = iframeEl.getBoundingClientRect();
      if (ir.width > 20 && ir.height > 20) {
        iframeOffset = {
          x: ir.left + iframeEl.clientLeft,
          y: ir.top + iframeEl.clientTop,
        };
      }
    }
  }

  let frameOffsetX = 0;
  let frameOffsetY = 0;
  let crossOriginChildFrame = false;

  if (window !== window.top) {
    try {
      let currentWin: Window = window;
      while (currentWin !== window.top) {
        const frameEl = currentWin.frameElement as HTMLElement | null;
        if (!frameEl) {
          crossOriginChildFrame = true;
          break;
        }
        const fr = frameEl.getBoundingClientRect();
        frameOffsetX += fr.left + frameEl.clientLeft;
        frameOffsetY += fr.top + frameEl.clientTop;
        currentWin = currentWin.parent;
      }
    } catch {
      crossOriginChildFrame = true;
    }
  }

  let inputs = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      blankSelector
    )
  ).filter((el) => {
    if (el.disabled || el.readOnly) {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  });

  if (inputs.length === 0) {
    const fallbackInputs = Array.from(
      document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        'input[type="text"]:not([readonly]), input:not([type]):not([readonly]), textarea:not([readonly])'
      )
    ).filter((el) => {
      if (el.disabled) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 14 || r.height <= 14) return false;
      const ph = (el.placeholder || '').toLowerCase();
      const name = (el.name || el.id || '').toLowerCase();
      if (
        ph.includes('search') ||
        ph.includes('code') ||
        ph.includes('pin') ||
        ph.includes('name') ||
        name.includes('search') ||
        name.includes('pin')
      ) {
        return false;
      }
      return true;
    });
    inputs = fallbackInputs;
  }

  if (inputs.length === 0) {
    return {
      boxPoints: [],
      isCharGrid: false,
      crossOriginChildFrame,
      iframeOffset,
    };
  }

  const isCharGrid =
    inputs.length > 1 &&
    inputs.every(
      (inp) =>
        inp instanceof HTMLInputElement &&
        (inp.maxLength === 1 ||
          inp.classList.contains('box-input') ||
          (inp.getAttribute('data-cy') ?? '').startsWith('box'))
    );

  const inputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  const areaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  const boxPoints: LocatedPoint[] = [];
  const targets = isCharGrid ? inputs : [inputs[0]];

  for (const inp of targets) {
    try {
      inp.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } catch {
      void 0;
    }
    try {
      if (inp instanceof HTMLTextAreaElement) {
        areaValueSetter?.call(inp, '');
      } else {
        inputValueSetter?.call(inp, '');
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    } catch {
      void 0;
    }
    const r = inp.getBoundingClientRect();
    boxPoints.push({
      x: Math.round(r.left + r.width / 2 + frameOffsetX),
      y: Math.round(r.top + r.height / 2 + frameOffsetY),
    });
  }

  return {
    boxPoints,
    isCharGrid,
    crossOriginChildFrame,
    iframeOffset,
  };
}

function fallbackSyntheticFillInFrame(
  fillText: string,
  autoSubmit: boolean
): boolean {
  const blankSelector =
    'input.typed-option-input, input.box-input, input[data-cy^="box"], [data-testid*="fib-input"], [data-testid*="blank-input"], [data-testid*="typed-input"] input, .typed-answer-wrapper input, .fib-container input, [data-testid="question-container"] input[type="text"]:not([readonly]), .question-container input[type="text"]:not([readonly])';
  const submitSelector =
    '[data-testid="msq-submit-button"], [data-testid="typed-submit-button"], [data-testid="save-button"], [data-testid*="submit-btn"], [data-testid*="submit-button"], [data-cy*="submit"], button.submit-button';

  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      blankSelector
    )
  ).filter((el) => {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    return r.width > 10 && r.height > 10;
  });

  if (inputs.length === 0) {
    return false;
  }

  const inputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set;
  const areaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  const isCharGrid =
    inputs.length > 1 &&
    inputs.every(
      (inp) =>
        inp instanceof HTMLInputElement &&
        (inp.maxLength === 1 || inp.classList.contains('box-input'))
    );

  if (isCharGrid) {
    const compact = fillText.replace(/\s+/g, '');
    const chars = Array.from(
      compact.length === inputs.length ? compact : fillText
    );
    inputs.forEach((inp, idx) => {
      const ch = chars[idx] ?? '';
      inp.focus();
      inputValueSetter?.call(inp, ch);
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    });
  } else {
    const first = inputs[0];
    first.focus();
    if (first instanceof HTMLTextAreaElement) {
      areaValueSetter?.call(first, fillText);
    } else {
      inputValueSetter?.call(first, fillText);
    }
    first.dispatchEvent(
      new InputEvent('input', { bubbles: true, data: fillText })
    );
    first.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if (autoSubmit) {
    setTimeout(() => {
      const sub =
        document.querySelector<HTMLElement>(submitSelector) ??
        Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) =>
          /^(?:submit|save|send|done|nộp|gửi|xác nhận)$/i.test(
            (b.textContent ?? '').replace(/\s+/g, ' ').trim()
          )
        );
      if (sub) {
        sub.click();
      } else {
        inputs[inputs.length - 1].dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
          })
        );
      }
    }, 100);
  }

  return true;
}

async function resolveViewportPointsInTab(
  tabId: number,
  indices: number[],
  multiSelect: boolean,
  submitOnly: boolean
): Promise<{ points: LocatedPoint[]; alreadySelectedCount: number }> {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: locateKahootChoicePointsInFrame,
    args: [indices, multiSelect, submitOnly],
  });

  let topIframeOffset: LocatedPoint = { x: 0, y: 0 };
  for (const item of frameResults) {
    if (item.frameId === 0 && item.result?.kahootIframeOffset) {
      topIframeOffset = item.result.kahootIframeOffset;
      break;
    }
  }

  for (const item of frameResults) {
    const res = item.result;
    if (!res) {
      continue;
    }
    if (res.points.length > 0 || res.alreadySelectedCount > 0) {
      const adjustedPoints = res.crossOriginChildFrame
        ? res.points.map((pt) => ({
            x: Math.round(pt.x + topIframeOffset.x),
            y: Math.round(pt.y + topIframeOffset.y),
          }))
        : res.points;
      return {
        points: adjustedPoints,
        alreadySelectedCount: res.alreadySelectedCount,
      };
    }
  }

  return { points: [], alreadySelectedCount: 0 };
}

async function resolveBlankInputPointsInTab(
  tabId: number
): Promise<{ boxPoints: LocatedPoint[]; isCharGrid: boolean }> {
  const frameResults = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: locateAndPrepareBlankInputsInFrame,
  });

  let topOffset: LocatedPoint = { x: 0, y: 0 };
  for (const item of frameResults) {
    if (item.frameId === 0 && item.result?.iframeOffset) {
      topOffset = item.result.iframeOffset;
      break;
    }
  }

  for (const item of frameResults) {
    const res = item.result;
    if (!res || res.boxPoints.length === 0) {
      continue;
    }
    const adjusted = res.crossOriginChildFrame
      ? res.boxPoints.map((pt) => ({
          x: Math.round(pt.x + topOffset.x),
          y: Math.round(pt.y + topOffset.y),
        }))
      : res.boxPoints;
    return { boxPoints: adjusted, isCharGrid: res.isCharGrid };
  }

  return { boxPoints: [], isCharGrid: false };
}

async function sendCdpMouseClick(
  tabId: number,
  x: number,
  y: number
): Promise<void> {
  const target: chrome._debugger.Debuggee = { tabId };

  const dispatchOnce = async (): Promise<void> => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
      button: 'none',
      buttons: 0,
      pointerType: 'mouse',
    });
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    });
    await sleepMs(14);
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    });
  };

  try {
    await dispatchOnce();
  } catch (err) {
    const msg = err instanceof Error ? err.message.toLowerCase() : '';
    if (msg.includes('not attached') || msg.includes('detached')) {
      attachedDebuggerTabs.delete(tabId);
      const reattach = await ensureTabDebuggerAttached(tabId);
      if (reattach.ok) {
        if (reattach.freshlyAttached) {
          await sleepMs(55);
        }
        await dispatchOnce();
        return;
      }
    }
    throw err;
  }
}

async function sendCdpInsertText(tabId: number, text: string): Promise<void> {
  const target: chrome._debugger.Debuggee = { tabId };
  await chrome.debugger.sendCommand(target, 'Input.insertText', { text });
}

async function sendCdpEnterKey(tabId: number): Promise<void> {
  const target: chrome._debugger.Debuggee = { tabId };
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await sleepMs(14);
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
}

async function performTrustedClickInternal(
  tabId: number,
  indices: number[],
  multiSelect: boolean,
  submitOnly: boolean
): Promise<RuntimeClickResponse> {
  const dedupKey = `${tabId}:${submitOnly ? 'sub' : indices.join(',')}:${multiSelect ? '1' : '0'}`;
  const now = Date.now();
  const lastAt = recentClickTimestamps.get(dedupKey) ?? 0;
  if (now - lastAt < DEDUP_CLICK_WINDOW_MS) {
    return { ok: true };
  }

  const attached = await ensureTabDebuggerAttached(tabId);
  if (!attached.ok) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: fallbackSyntheticClickInFrame,
        args: [indices, multiSelect, submitOnly],
      });
    } catch {
      void 0;
    }
    return {
      ok: false,
      canceledByUser: attached.canceledByUser,
      error: attached.error,
    };
  }

  if (attached.freshlyAttached) {
    await sleepMs(55);
  }

  try {
    const located = await resolveViewportPointsInTab(
      tabId,
      indices,
      multiSelect,
      submitOnly
    );

    if (located.points.length === 0 && located.alreadySelectedCount === 0) {
      return { ok: false };
    }

    recentClickTimestamps.set(dedupKey, Date.now());

    for (let i = 0; i < located.points.length; i += 1) {
      const pt = located.points[i];
      await sendCdpMouseClick(tabId, pt.x, pt.y);
      if (i + 1 < located.points.length) {
        await sleepMs(50);
      }
    }

    if (
      multiSelect &&
      !submitOnly &&
      (located.points.length > 0 || located.alreadySelectedCount > 0)
    ) {
      await sleepMs(115);
      const submitLocated = await resolveViewportPointsInTab(
        tabId,
        [],
        true,
        true
      );
      if (submitLocated.points.length > 0) {
        const subPt = submitLocated.points[0];
        await sendCdpMouseClick(tabId, subPt.x, subPt.y);
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'CDP trusted click failed',
    };
  }
}

async function performTrustedTextFillInternal(
  tabId: number,
  fillText: string,
  autoSubmit: boolean
): Promise<RuntimeClickResponse> {
  const trimmed = fillText.trim();
  if (!trimmed) {
    return { ok: false };
  }

  const dedupKey = `${tabId}:fill:${trimmed}:${autoSubmit ? '1' : '0'}`;
  const now = Date.now();
  const lastAt = recentClickTimestamps.get(dedupKey) ?? 0;
  if (now - lastAt < 250) {
    return { ok: true };
  }

  const attached = await ensureTabDebuggerAttached(tabId);
  if (!attached.ok) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: 'MAIN',
        func: fallbackSyntheticFillInFrame,
        args: [trimmed, autoSubmit],
      });
    } catch {
      void 0;
    }
    return {
      ok: false,
      canceledByUser: attached.canceledByUser,
      error: attached.error,
    };
  }

  if (attached.freshlyAttached) {
    await sleepMs(55);
  }

  try {
    const located = await resolveBlankInputPointsInTab(tabId);
    if (located.boxPoints.length === 0) {
      return { ok: false };
    }

    recentClickTimestamps.set(dedupKey, Date.now());

    if (located.isCharGrid) {
      const compact = trimmed.replace(/\s+/g, '');
      const chars = Array.from(
        compact.length === located.boxPoints.length ? compact : trimmed
      );
      for (let i = 0; i < located.boxPoints.length; i += 1) {
        const ch = chars[i] ?? '';
        if (!ch) {
          break;
        }
        const pt = located.boxPoints[i];
        await sendCdpMouseClick(tabId, pt.x, pt.y);
        await sleepMs(16);
        await sendCdpInsertText(tabId, ch);
        await sleepMs(18);
      }
    } else {
      const pt = located.boxPoints[0];
      await sendCdpMouseClick(tabId, pt.x, pt.y);
      await sleepMs(20);
      await sendCdpInsertText(tabId, trimmed);
    }

    if (autoSubmit) {
      await sleepMs(110);
      const submitLocated = await resolveViewportPointsInTab(
        tabId,
        [],
        true,
        true
      );
      if (submitLocated.points.length > 0) {
        const subPt = submitLocated.points[0];
        await sendCdpMouseClick(tabId, subPt.x, subPt.y);
      } else {
        await sendCdpEnterKey(tabId);
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'CDP trusted text fill failed',
    };
  }
}

export async function executeTrustedClickInTab(
  tabId: number | undefined,
  indices: number[],
  multiSelect: boolean,
  submitOnly = false
): Promise<RuntimeClickResponse> {
  if (typeof tabId !== 'number' || tabId < 0) {
    return { ok: false };
  }

  const previousTask = tabClickMutex.get(tabId) ?? Promise.resolve({ ok: false });
  const chainedTask = (async (): Promise<RuntimeClickResponse> => {
    try {
      await previousTask;
    } catch {
      void 0;
    }
    return performTrustedClickInternal(tabId, indices, multiSelect, submitOnly);
  })();

  tabClickMutex.set(tabId, chainedTask);
  try {
    return await chainedTask;
  } finally {
    if (tabClickMutex.get(tabId) === chainedTask) {
      tabClickMutex.delete(tabId);
    }
  }
}

export async function executeTrustedTextFillInTab(
  tabId: number | undefined,
  fillText: string,
  autoSubmit = true
): Promise<RuntimeClickResponse> {
  if (typeof tabId !== 'number' || tabId < 0) {
    return { ok: false };
  }

  const previousTask = tabClickMutex.get(tabId) ?? Promise.resolve({ ok: false });
  const chainedTask = (async (): Promise<RuntimeClickResponse> => {
    try {
      await previousTask;
    } catch {
      void 0;
    }
    return performTrustedTextFillInternal(tabId, fillText, autoSubmit);
  })();

  tabClickMutex.set(tabId, chainedTask);
  try {
    return await chainedTask;
  } finally {
    if (tabClickMutex.get(tabId) === chainedTask) {
      tabClickMutex.delete(tabId);
    }
  }
}
