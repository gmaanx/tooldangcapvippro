import type { RuntimeClickResponse } from '../shared/types';

const CDP_PROTOCOL_VERSION = '1.3';
const USER_CANCEL_COOLDOWN_MS = 8_000;
const DEDUP_CLICK_WINDOW_MS = 110;

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

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
        (item.url.startsWith('https://kahoot.it/') ||
          item.url.startsWith('https://create.kahoot.it/'))
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
            'Đang mở F12 DevTools trên tab Kahoot! Hãy đóng F12 để Auto-Click chuột thật hoạt động.',
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
  if (url.startsWith('https://create.kahoot.it/')) {
    return true;
  }
  if (!url.startsWith('https://kahoot.it/')) {
    return false;
  }
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return (
      pathname.startsWith('/start') ||
      pathname.startsWith('/getready') ||
      pathname.startsWith('/gameblock') ||
      pathname.startsWith('/answer') ||
      pathname.startsWith('/challenge')
    );
  } catch {
    return false;
  }
}

export function isKahootLobbyOrEndUrl(url: string | undefined): boolean {
  if (!url || !url.startsWith('https://kahoot.it/')) {
    return false;
  }
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return (
      pathname === '/' ||
      pathname.startsWith('/join') ||
      pathname.startsWith('/instructions') ||
      pathname.startsWith('/gameover') ||
      pathname.startsWith('/ranking') ||
      pathname.startsWith('/podium') ||
      pathname.startsWith('/feedback')
    );
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
      url: ['https://kahoot.it/*', 'https://create.kahoot.it/*'],
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
  const answerPrefixSelector =
    '[data-functional-selector^="answer-"], [data-functional-selector^="question-choice-"]:not([data-functional-selector^="question-choice-text-"])';
  const submitSelector =
    '[data-functional-selector="multi-select-submit-button"]';

  let kahootIframeOffset: LocatedPoint | null = null;
  if (window === window.top) {
    const iframeEl = document.querySelector<HTMLIFrameElement>(
      'iframe[src*="kahoot.it"]'
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
    const inner = raw.querySelector<HTMLElement>('button, [role="button"]');
    if (inner) {
      const r = inner.getBoundingClientRect();
      if (r.width > 8 && r.height > 8) {
        return inner;
      }
    }
    const ancestor = raw.closest<HTMLElement>('button, [role="button"]');
    if (
      ancestor &&
      ancestor.querySelectorAll(answerPrefixSelector).length <= 1
    ) {
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

  const findChoice = (idx: number): HTMLElement | null => {
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

  const points: LocatedPoint[] = [];
  let alreadySelectedCount = 0;

  if (submitOnly) {
    const submits = Array.from(
      document.querySelectorAll<HTMLElement>(submitSelector)
    );
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

  for (const idx of indices) {
    const choice = findChoice(idx);
    if (!choice) {
      continue;
    }
    if (multiSelect) {
      const btn = resolveButton(choice);
      const selected =
        choice.getAttribute('aria-checked') === 'true' ||
        btn.getAttribute('aria-checked') === 'true' ||
        choice.getAttribute('aria-pressed') === 'true' ||
        btn.getAttribute('aria-pressed') === 'true' ||
        choice.getAttribute('data-selected') === 'true' ||
        btn.getAttribute('data-selected') === 'true';
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
  const submitSelector =
    '[data-functional-selector="multi-select-submit-button"]';
  if (submitOnly) {
    const sub = document.querySelector<HTMLElement>(submitSelector);
    if (sub) {
      sub.click();
      return true;
    }
    return false;
  }
  let clicked = false;
  for (const idx of indices) {
    const el = document.querySelector<HTMLElement>(
      '[data-functional-selector="answer-' +
        String(idx) +
        '"], [data-functional-selector="question-choice-' +
        String(idx) +
        '"]'
    );
    if (el) {
      if (multiSelect && el.getAttribute('aria-checked') === 'true') {
        clicked = true;
        continue;
      }
      el.click();
      clicked = true;
    }
  }
  if (multiSelect && clicked) {
    setTimeout(() => {
      document.querySelector<HTMLElement>(submitSelector)?.click();
    }, 110);
  }
  return clicked;
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
