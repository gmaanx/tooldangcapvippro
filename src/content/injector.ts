import {
  BRIDGE_SOURCE,
  ISOLATED_BRIDGE_SOURCE,
  SELECTORS,
  WAYGROUND_SELECTORS,
} from '../shared/constants';
import {
  extractGamePin,
  extractUuid,
  isKahootHostname,
  isWaygroundHostname,
} from '../shared/normalize';
import type {
  IsolatedToMainClickEnvelope,
  KahootChallengePinPayload,
  KahootRestPayload,
  MainWorldQuestionEnvelope,
  MainWorldQuizIdEnvelope,
  MainWorldQuizPayloadEnvelope,
  MainWorldVerifiedAnswerEnvelope,
  WsQuestionSignal,
} from '../shared/types';

declare global {
  interface Window {
    __kahootHybridMainWorldInstalled?: boolean;
    __kahootHybridClickListenerAttached?: boolean;
    __kahootHybridFocusGuardInstalled?: boolean;
    __kahootHybridMainClickHandler?: (
      envelope: IsolatedToMainClickEnvelope
    ) => void;
  }
}

interface CometdEnvelope {
  channel?: string;
  data?: {
    id?: number;
    type?: string;
    quizId?: string;
    quizUuid?: string;
    content?: string | Record<string, unknown>;
  };
}

interface KahootWsChoice {
  answer?: string;
  text?: string;
}

const IS_WAYGROUND_HOST = isWaygroundHostname(window.location.hostname);
const IS_KAHOOT_HOST = isKahootHostname(window.location.hostname);

function isFocusGuardEnabled(): boolean {
  const attr = document.documentElement?.getAttribute(
    'data-hybrid-focus-guard'
  );
  return attr !== '0';
}

function installWaygroundFocusGuard(): void {
  if (!IS_WAYGROUND_HOST || window.__kahootHybridFocusGuardInstalled) {
    return;
  }
  window.__kahootHybridFocusGuardInstalled = true;

  try {
    const docProto = Document.prototype;
    const origVisibility = Object.getOwnPropertyDescriptor(
      docProto,
      'visibilityState'
    );
    const origWebkitVisibility = Object.getOwnPropertyDescriptor(
      docProto,
      'webkitVisibilityState'
    );
    const origHidden = Object.getOwnPropertyDescriptor(docProto, 'hidden');
    const origWebkitHidden = Object.getOwnPropertyDescriptor(
      docProto,
      'webkitHidden'
    );
    const origHasFocus = docProto.hasFocus;

    Object.defineProperty(docProto, 'visibilityState', {
      configurable: true,
      enumerable: true,
      get() {
        if (isFocusGuardEnabled()) {
          return 'visible';
        }
        return origVisibility?.get ? origVisibility.get.call(this) : 'visible';
      },
    });

    if (origWebkitVisibility) {
      Object.defineProperty(docProto, 'webkitVisibilityState', {
        configurable: true,
        enumerable: true,
        get() {
          if (isFocusGuardEnabled()) {
            return 'visible';
          }
          return origWebkitVisibility.get
            ? origWebkitVisibility.get.call(this)
            : 'visible';
        },
      });
    }

    Object.defineProperty(docProto, 'hidden', {
      configurable: true,
      enumerable: true,
      get() {
        if (isFocusGuardEnabled()) {
          return false;
        }
        return origHidden?.get ? origHidden.get.call(this) : false;
      },
    });

    if (origWebkitHidden) {
      Object.defineProperty(docProto, 'webkitHidden', {
        configurable: true,
        enumerable: true,
        get() {
          if (isFocusGuardEnabled()) {
            return false;
          }
          return origWebkitHidden.get ? origWebkitHidden.get.call(this) : false;
        },
      });
    }

    if (typeof origHasFocus === 'function') {
      docProto.hasFocus = function patchedHasFocus(): boolean {
        if (isFocusGuardEnabled()) {
          return true;
        }
        return origHasFocus.call(this);
      };
    }
  } catch {
    void 0;
  }

  const swallowVisibilityEvent = (event: Event): void => {
    if (!isFocusGuardEnabled()) {
      return;
    }
    event.stopImmediatePropagation();
    event.stopPropagation();
  };

  const swallowWindowBlurEvent = (event: Event): void => {
    if (!isFocusGuardEnabled()) {
      return;
    }
    if (
      event.target === window ||
      event.target === document ||
      event.target === document.documentElement
    ) {
      event.stopImmediatePropagation();
      event.stopPropagation();
    }
  };

  window.addEventListener('visibilitychange', swallowVisibilityEvent, true);
  document.addEventListener('visibilitychange', swallowVisibilityEvent, true);
  document.addEventListener(
    'webkitvisibilitychange',
    swallowVisibilityEvent,
    true
  );
  window.addEventListener('blur', swallowWindowBlurEvent, true);
  document.addEventListener('blur', swallowWindowBlurEvent, true);
  document.addEventListener('mouseleave', swallowWindowBlurEvent, true);
}

function markMainBridgeReady(): void {
  if (document.documentElement) {
    document.documentElement.setAttribute('data-kahoot-hybrid-main', '2');
  }
}

function postQuizId(quizId: string): void {
  const message: MainWorldQuizIdEnvelope = {
    source: BRIDGE_SOURCE,
    type: 'QUIZ_ID_DETECTED',
    quizId,
  };
  window.postMessage(message, '*');
}

function postQuizPayload(quizId: string, payload: KahootRestPayload): void {
  const message: MainWorldQuizPayloadEnvelope = {
    source: BRIDGE_SOURCE,
    type: 'QUIZ_PAYLOAD_CAPTURED',
    quizId,
    payload,
  };
  window.postMessage(message, '*');
}

function postQuestionSignal(payload: WsQuestionSignal): void {
  const message: MainWorldQuestionEnvelope = {
    source: BRIDGE_SOURCE,
    type: 'WS_QUESTION_EVENT',
    payload,
  };
  window.postMessage(message, '*');
}

function postVerifiedAnswer(correctChoices: number[]): void {
  const message: MainWorldVerifiedAnswerEnvelope = {
    source: BRIDGE_SOURCE,
    type: 'VERIFIED_ANSWER_REVEALED',
    correctChoices,
  };
  window.postMessage(message, '*');
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function inspectUrlForQuizUuid(urlCandidate: unknown): void {
  if (typeof urlCandidate !== 'string') {
    return;
  }
  if (
    urlCandidate.includes('/rest/kahoots/') ||
    urlCandidate.includes('quizId=')
  ) {
    const uuid = extractUuid(urlCandidate);
    if (uuid) {
      postQuizId(uuid);
    }
  }
}

function parseContentRecord(
  rawContent: string | Record<string, unknown> | undefined
): Record<string, unknown> | null {
  if (!rawContent) {
    return null;
  }
  if (typeof rawContent === 'string') {
    const parsed = safeJsonParse(rawContent);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  }
  if (typeof rawContent === 'object' && !Array.isArray(rawContent)) {
    return rawContent;
  }
  return null;
}

function extractVerifiedChoices(content: Record<string, unknown>): number[] {
  if (!Array.isArray(content.correctChoices)) {
    return [];
  }
  const indices: number[] = [];
  for (const item of content.correctChoices) {
    if (
      typeof item === 'number' &&
      Number.isInteger(item) &&
      item >= 0 &&
      item <= 7 &&
      !indices.includes(item)
    ) {
      indices.push(item);
    }
  }
  return indices;
}

function extractQuestionSignal(
  packetId: number | undefined,
  content: Record<string, unknown>
): WsQuestionSignal | null {
  if (
    'pointsData' in content ||
    'rank' in content ||
    'correctChoices' in content ||
    'isCorrect' in content
  ) {
    return null;
  }

  const blockType = String(
    content.gameBlockType ?? content.type ?? ''
  ).toLowerCase();

  const isPlayableType =
    blockType === 'quiz' ||
    blockType === 'multiple_select_quiz' ||
    blockType === 'true_or_false' ||
    packetId === 1 ||
    packetId === 2;

  if (!isPlayableType) {
    return null;
  }

  const questionIndex =
    typeof content.questionIndex === 'number'
      ? content.questionIndex
      : typeof content.gameBlockIndex === 'number'
        ? content.gameBlockIndex
        : -1;

  const questionText =
    typeof content.title === 'string'
      ? content.title
      : typeof content.question === 'string'
        ? content.question
        : '';

  const rawChoices = Array.isArray(content.choices)
    ? (content.choices as KahootWsChoice[])
    : [];

  const options = rawChoices.map((choice) => {
    if (!choice || typeof choice !== 'object') {
      return '';
    }
    return String(choice.answer ?? choice.text ?? '');
  });

  const answerCountsMap = Array.isArray(content.quizQuestionAnswers)
    ? content.quizQuestionAnswers
    : null;

  const indexedChoiceCount =
    answerCountsMap &&
    questionIndex >= 0 &&
    typeof answerCountsMap[questionIndex] === 'number'
      ? Number(answerCountsMap[questionIndex])
      : 0;

  const optionCount =
    typeof content.numberOfChoices === 'number' && content.numberOfChoices > 0
      ? content.numberOfChoices
      : options.length > 0
        ? options.length
        : indexedChoiceCount > 0
          ? indexedChoiceCount
          : blockType === 'true_or_false'
            ? 2
            : 4;

  const multiSelect =
    blockType === 'multiple_select_quiz' || content.selectMultiple === true;

  const hasQuestionText =
    questionText.trim().length > 0 &&
    options.some((opt) => opt.trim().length > 0);

  const isActiveQuestionStart =
    packetId === 2 ||
    (typeof content.timeAvailable === 'number' &&
      !('getReadyTimeAvailable' in content));

  if (!hasQuestionText && !isActiveQuestionStart) {
    return null;
  }

  const rawTime =
    typeof content.timeAvailable === 'number' && content.timeAvailable > 0
      ? content.timeAvailable
      : typeof content.time === 'number' && content.time > 0
        ? content.time
        : 0;
  const timeAvailableMs =
    rawTime > 0 ? (rawTime <= 300 ? rawTime * 1000 : rawTime) : undefined;

  return {
    questionIndex,
    questionText,
    options,
    multiSelect,
    optionCount,
    hasQuestionText,
    timeAvailableMs,
  };
}

function inspectWebSocketFrame(rawFrame: string): void {
  const parsed = safeJsonParse(rawFrame);
  if (!parsed) {
    return;
  }

  const envelopes: CometdEnvelope[] = Array.isArray(parsed)
    ? (parsed as CometdEnvelope[])
    : [parsed as CometdEnvelope];

  for (const envelope of envelopes) {
    const data = envelope?.data;
    if (!data || typeof data !== 'object') {
      continue;
    }

    const topUuid = extractUuid(String(data.quizId ?? data.quizUuid ?? ''));
    if (topUuid) {
      postQuizId(topUuid);
    }

    const content = parseContentRecord(data.content);
    if (!content) {
      continue;
    }

    const nestedUuid = extractUuid(
      String(content.quizId ?? content.quizUuid ?? content.uuid ?? '')
    );
    if (nestedUuid) {
      postQuizId(nestedUuid);
    }

    const verifiedChoices = extractVerifiedChoices(content);
    if (verifiedChoices.length > 0) {
      postVerifiedAnswer(verifiedChoices);
    }

    const signal = extractQuestionSignal(data.id, content);
    if (signal) {
      postQuestionSignal(signal);
    }
  }
}

function collectWaygroundVisibleChoices(): HTMLElement[] {
  const indexed = new Map<number, HTMLElement>();
  for (let i = 0; i < 8; i += 1) {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        WAYGROUND_SELECTORS.INDEXED_OPTION(i)
      )
    );
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
    document.querySelectorAll<HTMLElement>(
      WAYGROUND_SELECTORS.ALL_OPTION_CANDIDATES
    )
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
}

function findVisibleChoiceElement(index: number): HTMLElement | null {
  if (IS_WAYGROUND_HOST) {
    return collectWaygroundVisibleChoices()[index] ?? null;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(SELECTORS.ANSWER_BY_INDEX(index))
  );
  let fallback: HTMLElement | null = null;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 8 || rect.height <= 8) {
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

function findVisibleSubmitButton(): HTMLElement | null {
  if (IS_WAYGROUND_HOST) {
    const wgCandidates = Array.from(
      document.querySelectorAll<HTMLElement>(WAYGROUND_SELECTORS.SUBMIT_BUTTON)
    );
    for (const el of wgCandidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width > 8 && rect.height > 8) {
        return el;
      }
    }
    const textBtns = Array.from(document.querySelectorAll<HTMLElement>('button'));
    for (const btn of textBtns) {
      const rect = btn.getBoundingClientRect();
      if (rect.width <= 8 || rect.height <= 8) {
        continue;
      }
      const label = (btn.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (/^(?:submit|save|send|done|nộp|gửi|xác nhận)$/i.test(label)) {
        return btn;
      }
    }
    return null;
  }

  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(SELECTORS.MULTI_SELECT_SUBMIT)
  );
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 8 && rect.height > 8) {
      return el;
    }
  }
  return null;
}

function resolveSingleChoiceClickable(rawTarget: HTMLElement): HTMLElement {
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
  const guardSel = IS_WAYGROUND_HOST
    ? WAYGROUND_SELECTORS.ALL_OPTION_CANDIDATES
    : SELECTORS.ANSWER_PREFIX;
  if (ancestorBtn && ancestorBtn.querySelectorAll(guardSel).length <= 1) {
    return ancestorBtn;
  }
  return rawTarget;
}

function isMainWorldElementClickable(rawTarget: HTMLElement): boolean {
  const target = resolveSingleChoiceClickable(rawTarget);
  if (
    rawTarget.hasAttribute('disabled') ||
    target.hasAttribute('disabled') ||
    rawTarget.getAttribute('aria-disabled') === 'true' ||
    target.getAttribute('aria-disabled') === 'true'
  ) {
    return false;
  }
  const rect = target.getBoundingClientRect();
  if (rect.width <= 8 || rect.height <= 8) {
    return false;
  }
  const style = window.getComputedStyle(target);
  return (
    style.pointerEvents !== 'none' &&
    style.visibility !== 'hidden' &&
    Number.parseFloat(style.opacity || '1') > 0.15
  );
}

function triggerMainWorldNativeClick(rawTarget: HTMLElement): void {
  const target = resolveSingleChoiceClickable(rawTarget);
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

  const mouseInit: MouseEventInit = {
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
      new MouseEvent('mousedown', { ...mouseInit, buttons: 1, detail: 1 })
    );
    dispatchNode.dispatchEvent(
      new MouseEvent('mouseup', { ...mouseInit, buttons: 0, detail: 1 })
    );
  } catch {
    void 0;
  }

  target.click();
}

function triggerMainWorldTextFill(fillText: string, autoSubmit: boolean): void {
  const inputs = Array.from(
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

  if (inputs.length === 0) {
    return;
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
      const submitBtn = findVisibleSubmitButton();
      if (submitBtn && isMainWorldElementClickable(submitBtn)) {
        triggerMainWorldNativeClick(submitBtn);
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
}

function handleIsolatedClickCommand(envelope: IsolatedToMainClickEnvelope): void {
  if (typeof envelope.fillText === 'string' && envelope.fillText.length > 0) {
    triggerMainWorldTextFill(
      envelope.fillText,
      envelope.autoSubmit !== false
    );
    return;
  }

  if (envelope.submitMultiSelect) {
    const submitBtn = findVisibleSubmitButton();
    if (submitBtn && isMainWorldElementClickable(submitBtn)) {
      triggerMainWorldNativeClick(submitBtn);
    }
    return;
  }

  for (const idx of envelope.indices) {
    const choiceEl = findVisibleChoiceElement(idx);
    if (choiceEl && isMainWorldElementClickable(choiceEl)) {
      triggerMainWorldNativeClick(choiceEl);
    }
  }
}

function installClickBridgeAlways(): void {
  window.__kahootHybridMainClickHandler = handleIsolatedClickCommand;
  if (!window.__kahootHybridClickListenerAttached) {
    window.__kahootHybridClickListenerAttached = true;
    window.addEventListener('message', (event: MessageEvent) => {
      if (
        event.source !== window ||
        !event.data ||
        typeof event.data !== 'object'
      ) {
        return;
      }
      const candidate = event.data as Partial<IsolatedToMainClickEnvelope>;
      if (
        candidate.source === ISOLATED_BRIDGE_SOURCE &&
        candidate.type === 'EXEC_MAIN_WORLD_CLICK' &&
        Array.isArray(candidate.indices)
      ) {
        window.__kahootHybridMainClickHandler?.(
          candidate as IsolatedToMainClickEnvelope
        );
      }
    });
  }
  markMainBridgeReady();
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', markMainBridgeReady, {
      once: true,
    });
  }
}

function installMainWorldInterceptors(): void {
  installWaygroundFocusGuard();
  installClickBridgeAlways();

  if (!IS_KAHOOT_HOST || window.__kahootHybridMainWorldInstalled) {
    return;
  }
  window.__kahootHybridMainWorldInstalled = true;

  const NativeWebSocket = window.WebSocket;
  const ProxiedWebSocket = new Proxy(NativeWebSocket, {
    construct(target, argArray, newTarget) {
      const socket = Reflect.construct(
        target,
        argArray,
        newTarget
      ) as WebSocket;
      try {
        inspectUrlForQuizUuid(argArray[0]);
        socket.addEventListener('message', (event: MessageEvent) => {
          if (typeof event.data === 'string' && event.data.length > 2) {
            queueMicrotask(() => {
              try {
                inspectWebSocketFrame(event.data as string);
              } catch {
                return;
              }
            });
          }
        });
      } catch {
        return socket;
      }
      return socket;
    },
  });

  window.WebSocket = ProxiedWebSocket;

  if (typeof window.fetch === 'function') {
    const NativeFetch = window.fetch;
    window.fetch = new Proxy(NativeFetch, {
      apply(target, thisArg, argArray) {
        let requestUrl = '';
        try {
          const firstArg = argArray[0];
          if (typeof firstArg === 'string') {
            requestUrl = firstArg;
          } else if (firstArg instanceof Request) {
            requestUrl = firstArg.url;
          } else if (firstArg instanceof URL) {
            requestUrl = firstArg.href;
          }
          if (requestUrl) {
            inspectUrlForQuizUuid(requestUrl);
          }
        } catch {
          return Reflect.apply(target, thisArg, argArray);
        }

        const fetchPromise = Reflect.apply(
          target,
          thisArg,
          argArray
        ) as Promise<Response>;

        if (
          requestUrl.includes('/rest/kahoots/') ||
          requestUrl.includes('/rest/challenges/')
        ) {
          const detectedId =
            extractUuid(requestUrl) ?? extractGamePin(requestUrl);
          void (async () => {
            try {
              const res = await fetchPromise;
              if (!res || !res.ok) {
                return;
              }
              const cloned = res.clone();
              const json = (await cloned.json()) as KahootRestPayload &
                KahootChallengePinPayload;
              const quizObj =
                json.kahoot && Array.isArray(json.kahoot.questions)
                  ? json.kahoot
                  : json;
              if (quizObj && Array.isArray(quizObj.questions)) {
                const finalId =
                  extractUuid(String(quizObj.uuid ?? '')) ??
                  detectedId ??
                  'captured-quiz';
                postQuizPayload(finalId, quizObj);
              }
            } catch {
              return;
            }
          })();
        }

        return fetchPromise;
      },
    });
  }

  if (typeof window.XMLHttpRequest === 'function') {
    const NativeXhrOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = new Proxy(NativeXhrOpen, {
      apply(target, thisArg: XMLHttpRequest, argArray) {
        try {
          const methodUrl = typeof argArray[1] === 'string' ? argArray[1] : '';
          if (methodUrl) {
            inspectUrlForQuizUuid(methodUrl);
          }
          if (methodUrl.includes('/rest/kahoots/')) {
            const detectedUuid = extractUuid(methodUrl);
            if (detectedUuid) {
              thisArg.addEventListener('load', () => {
                try {
                  if (
                    thisArg.status >= 200 &&
                    thisArg.status < 300 &&
                    typeof thisArg.responseText === 'string'
                  ) {
                    const parsed = safeJsonParse(
                      thisArg.responseText
                    ) as KahootRestPayload | null;
                    if (parsed && Array.isArray(parsed.questions)) {
                      postQuizPayload(detectedUuid, parsed);
                    }
                  }
                } catch {
                  return;
                }
              });
            }
          }
        } catch {
          return Reflect.apply(target, thisArg, argArray);
        }
        return Reflect.apply(target, thisArg, argArray);
      },
    });
  }
}

installMainWorldInterceptors();
