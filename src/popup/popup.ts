import {
  STORAGE_KEYS,
  TARGET_SCORE_MAX,
  TARGET_SCORE_MIN,
} from '../shared/constants';
import {
  buildQuestionStateHash,
  computeTargetScoreDelayMs,
  extractGamePin,
  extractUuid,
} from '../shared/normalize';
import { saveSettings } from '../shared/storage';
import type {
  ConsensusMode,
  ContentPushMessage,
  EngineSettings,
  EngineTelemetry,
  ResolutionTier,
  RuntimeCacheResponse,
  RuntimeRequestMessage,
  RuntimeResolveResponse,
  RuntimeStatusResponse,
  TriggerMode,
} from '../shared/types';

function queryRequired<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) {
    throw new Error(`Missing required popup element: ${selector}`);
  }
  return el;
}

async function sendMessage<TResponse>(
  message: RuntimeRequestMessage
): Promise<TResponse | null> {
  try {
    return (await chrome.runtime.sendMessage(message)) as TResponse;
  } catch {
    return null;
  }
}

function formatTierName(tier: ResolutionTier | null): string {
  switch (tier) {
    case 'tier1_cache':
      return 'T1 Cache';
    case 'tier1_learned':
      return 'T1 Learned';
    case 'tier3_consensus':
      return 'T3 Vote ✓';
    case 'tier3_groq':
      return 'T3 Groq';
    case 'tier3_gemini':
      return 'T3 Gemini';
    case 'tier3_openrouter':
      return 'T3 Router';
    case 'tier3_mistral':
      return 'T3 Mistral';
    case 'tier3_local_ai':
      return 'T3 Nano';
    case 'tier4_vision':
      return 'T4 Vision';
    case 'tier4_clipboard':
      return 'T4 Clip';
    default:
      return 'Idle';
  }
}

function describeTriggerMode(mode: TriggerMode, targetScore: number): string {
  if (mode === 'instant_auto_click') {
    return 'Instant Auto-Click (+1000 pts)';
  }
  if (mode === 'target_score') {
    return `Target Score (~${targetScore} pts)`;
  }
  if (mode === 'smart_human_jitter') {
    return 'Custom Delay (ms)';
  }
  return 'Highlight Only';
}

async function findPopupTargetKahootTab(): Promise<chrome.tabs.Tab | undefined> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  if (
    activeTab &&
    typeof activeTab.id === 'number' &&
    (activeTab.url?.startsWith('https://kahoot.it/') ||
      activeTab.url?.startsWith('https://play.kahoot.it/'))
  ) {
    return activeTab;
  }

  const kahootTabs = await chrome.tabs.query({
    url: ['https://kahoot.it/*', 'https://play.kahoot.it/*'],
  });
  const activeKahootTab = kahootTabs.find(
    (tab) => tab.active && typeof tab.id === 'number'
  );
  if (activeKahootTab) {
    return activeKahootTab;
  }

  return kahootTabs.find((tab) => typeof tab.id === 'number') ?? activeTab;
}

function syncTargetScoreSliderUi(rawValue?: number): number {
  const slider = queryRequired<HTMLInputElement>('#target-score');
  const output = queryRequired<HTMLOutputElement>('#target-score-output');
  const hint = queryRequired<HTMLElement>('#target-score-hint');

  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    const clamped = Math.min(
      TARGET_SCORE_MAX,
      Math.max(TARGET_SCORE_MIN, Math.round(rawValue))
    );
    slider.value = String(clamped);
  }

  const score = Number.parseInt(slider.value, 10) || 860;
  slider.style.setProperty('--attr-min', slider.min || '600');
  slider.style.setProperty('--attr-max', slider.max || '1000');
  slider.style.setProperty('--control-value', String(score));

  if (score >= 990) {
    output.textContent = '1000 pts (Max)';
    slider.setAttribute('aria-valuetext', '1000 points maximum speed');
    hint.textContent = 'Clicks immediately (<0.5s) for +1000 points.';
  } else {
    const estWaitSec = (
      computeTargetScoreDelayMs(score, 20_000, 0, 0) / 1000
    ).toFixed(1);
    output.textContent = `~${score} pts (±25)`;
    slider.setAttribute(
      'aria-valuetext',
      `Approximately ${score} points plus or minus 25`
    );
    hint.textContent = `Auto-scales to each question timer (~${estWaitSec}s click on a 20s question)`;
  }

  document.querySelectorAll<HTMLButtonElement>('.preset-pill').forEach((btn) => {
    const presetVal = Number.parseInt(btn.dataset.score ?? '', 10);
    btn.dataset.active = Math.abs(presetVal - score) <= 10 ? 'true' : 'false';
  });

  return score;
}

function installValidationSync(form: HTMLFormElement): void {
  const dirtyControls = new WeakMap<
    HTMLInputElement,
    { interacted: boolean; blurred: boolean }
  >();
  const supportsUserInvalid = CSS.supports('selector(:user-invalid)');

  const syncAriaState = (input: HTMLInputElement): void => {
    const invalidByNative = supportsUserInvalid
      ? input.matches(':user-invalid')
      : input.classList.contains('user-invalid-fallback');
    input.setAttribute('aria-invalid', invalidByNative ? 'true' : 'false');
  };

  form.addEventListener(
    'blur',
    (event: Event) => {
      const target = event.target;
      if (
        !(target instanceof HTMLInputElement) ||
        target.type === 'range' ||
        target.type === 'radio' ||
        target.type === 'checkbox'
      ) {
        return;
      }
      validateCrossFieldBounds();
      if (!supportsUserInvalid) {
        const state = dirtyControls.get(target) ?? {
          interacted: false,
          blurred: false,
        };
        state.blurred = true;
        dirtyControls.set(target, state);
        if (state.interacted) {
          target.classList.toggle(
            'user-invalid-fallback',
            !target.checkValidity()
          );
        }
      }
      syncAriaState(target);
    },
    true
  );

  form.addEventListener('input', (event: Event) => {
    const target = event.target;
    if (
      !(target instanceof HTMLInputElement) ||
      target.type === 'range' ||
      target.type === 'radio' ||
      target.type === 'checkbox'
    ) {
      return;
    }
    target.setCustomValidity('');
    if (!supportsUserInvalid) {
      const state = dirtyControls.get(target) ?? {
        interacted: false,
        blurred: false,
      };
      state.interacted = true;
      dirtyControls.set(target, state);
      if (state.blurred) {
        target.classList.toggle(
          'user-invalid-fallback',
          !target.checkValidity()
        );
      }
    }
    if (target.hasAttribute('aria-invalid')) {
      syncAriaState(target);
    }
  });
}

function validateCrossFieldBounds(): boolean {
  const minInput = queryRequired<HTMLInputElement>('#min-delay-ms');
  const maxInput = queryRequired<HTMLInputElement>('#max-delay-ms');

  minInput.setCustomValidity('');
  maxInput.setCustomValidity('');

  const minVal = Number.parseInt(minInput.value.trim(), 10);
  const maxVal = Number.parseInt(maxInput.value.trim(), 10);

  if (!Number.isFinite(minVal) || minVal < 0) {
    minInput.setCustomValidity('Enter a non-negative integer.');
    return false;
  }

  if (!Number.isFinite(maxVal) || maxVal < minVal) {
    maxInput.setCustomValidity(
      'Max Delay must be greater than or equal to Min Delay.'
    );
    return false;
  }

  return true;
}

function bindPasswordToggle(
  buttonId: string,
  inputId: string,
  labelBase: string
): void {
  const button = queryRequired<HTMLButtonElement>(buttonId);
  const input = queryRequired<HTMLInputElement>(inputId);

  button.addEventListener('click', () => {
    const revealing = input.type === 'password';
    input.type = revealing ? 'text' : 'password';
    button.setAttribute('aria-pressed', revealing ? 'true' : 'false');
    button.setAttribute(
      'aria-label',
      revealing ? `Hide ${labelBase}` : `Show ${labelBase}`
    );
    button.textContent = revealing ? 'Hide' : 'Show';
  });
}

function renderTelemetry(telemetry: EngineTelemetry): void {
  const tierEl = queryRequired<HTMLElement>('#telemetry-tier');
  const latencyEl = queryRequired<HTMLElement>('#telemetry-latency');
  const cacheEl = queryRequired<HTMLElement>('#telemetry-cache');
  const cacheDetailEl = queryRequired<HTMLElement>('#cache-detail');

  tierEl.textContent = formatTierName(telemetry.lastTier);
  latencyEl.textContent =
    typeof telemetry.lastLatencyMs === 'number'
      ? `${telemetry.lastLatencyMs}ms`
      : '—';

  const learned = telemetry.learnedQuestionCount ?? 0;
  const totalCached = telemetry.cachedQuestionCount + learned;
  cacheEl.textContent = `${totalCached} Qs`;

  if (telemetry.cachedQuizId && telemetry.cachedQuestionCount > 0) {
    cacheDetailEl.textContent =
      learned > 0
        ? `Cached "${telemetry.cachedQuizTitle}" (${telemetry.cachedQuestionCount} Qs) + ${learned} self-learned`
        : `Cached "${telemetry.cachedQuizTitle}" (${telemetry.cachedQuestionCount} questions)`;
  } else if (telemetry.lastError) {
    cacheDetailEl.textContent = telemetry.lastError;
  } else if (learned > 0) {
    cacheDetailEl.textContent = `Self-learning bank active: ${learned} verified/solved questions (0–1ms).`;
  } else {
    cacheDetailEl.textContent = 'No quiz cached in memory.';
  }
}

function updateModeSubrowsVisibility(mode: TriggerMode): void {
  queryRequired<HTMLElement>('#target-score-row').hidden =
    mode !== 'target_score';
  queryRequired<HTMLElement>('#jitter-bounds-row').hidden =
    mode !== 'smart_human_jitter';
}

function populateForm(settings: EngineSettings): void {
  queryRequired<HTMLInputElement>('#engine-enabled').checked = settings.enabled;
  queryRequired<HTMLInputElement>('#consensus-mode').checked =
    settings.consensusMode !== 'fastest_first';
  queryRequired<HTMLInputElement>('#quiz-id').value = settings.quizId;
  queryRequired<HTMLInputElement>('#min-delay-ms').value = String(
    settings.minDelayMs
  );
  queryRequired<HTMLInputElement>('#max-delay-ms').value = String(
    settings.maxDelayMs
  );
  queryRequired<HTMLInputElement>('#groq-api-key').value = settings.groqApiKey;
  queryRequired<HTMLInputElement>('#gemini-api-key').value =
    settings.geminiApiKey;
  queryRequired<HTMLInputElement>('#openrouter-api-key').value =
    settings.openRouterApiKey;
  queryRequired<HTMLInputElement>('#mistral-api-key').value =
    settings.mistralApiKey;
  queryRequired<HTMLTextAreaElement>('#pinned-context').value =
    settings.pinnedContext;

  syncTargetScoreSliderUi(settings.targetScore);

  const radioSelector = `input[name="triggerMode"][value="${settings.triggerMode}"]`;
  const matchingRadio = document.querySelector<HTMLInputElement>(radioSelector);
  if (matchingRadio) {
    matchingRadio.checked = true;
  }

  updateModeSubrowsVisibility(settings.triggerMode);
}

function readFormSettings(): EngineSettings {
  const enabled = queryRequired<HTMLInputElement>('#engine-enabled').checked;
  const consensusChecked =
    queryRequired<HTMLInputElement>('#consensus-mode').checked;
  const consensusMode: ConsensusMode = consensusChecked
    ? 'consensus_vote'
    : 'fastest_first';
  const rawQuizInput = queryRequired<HTMLInputElement>('#quiz-id').value.trim();
  const normalizedIdentifier =
    extractUuid(rawQuizInput) ?? extractGamePin(rawQuizInput) ?? rawQuizInput;
  const selectedRadio = document.querySelector<HTMLInputElement>(
    'input[name="triggerMode"]:checked'
  );
  const triggerMode: TriggerMode =
    selectedRadio?.value === 'highlight_only' ||
    selectedRadio?.value === 'instant_auto_click' ||
    selectedRadio?.value === 'target_score' ||
    selectedRadio?.value === 'smart_human_jitter'
      ? selectedRadio.value
      : 'instant_auto_click';

  const targetScore = Math.min(
    TARGET_SCORE_MAX,
    Math.max(
      TARGET_SCORE_MIN,
      Number.parseInt(
        queryRequired<HTMLInputElement>('#target-score').value,
        10
      ) || 860
    )
  );

  const minDelayMs = Math.max(
    0,
    Number.parseInt(
      queryRequired<HTMLInputElement>('#min-delay-ms').value.trim(),
      10
    ) || 1100
  );
  const maxCandidate = Math.max(
    0,
    Number.parseInt(
      queryRequired<HTMLInputElement>('#max-delay-ms').value.trim(),
      10
    ) || 2100
  );
  const maxDelayMs = Math.max(minDelayMs, maxCandidate);

  return {
    enabled,
    quizId: normalizedIdentifier,
    groqApiKey: queryRequired<HTMLInputElement>('#groq-api-key').value.trim(),
    geminiApiKey: queryRequired<HTMLInputElement>(
      '#gemini-api-key'
    ).value.trim(),
    openRouterApiKey: queryRequired<HTMLInputElement>(
      '#openrouter-api-key'
    ).value.trim(),
    mistralApiKey: queryRequired<HTMLInputElement>(
      '#mistral-api-key'
    ).value.trim(),
    consensusMode,
    pinnedContext: queryRequired<HTMLTextAreaElement>('#pinned-context').value,
    triggerMode,
    targetScore,
    minDelayMs,
    maxDelayMs,
  };
}

function showStatus(message: string, isError = false): void {
  const banner = queryRequired<HTMLElement>('#form-status');
  banner.dataset.error = isError ? 'true' : 'false';
  banner.textContent = message;
}

async function initializePopup(): Promise<void> {
  const form = queryRequired<HTMLFormElement>('#settings-form');
  const saveBtn = queryRequired<HTMLButtonElement>('#save-settings-btn');
  const prefetchBtn = queryRequired<HTMLButtonElement>('#prefetch-cache-btn');
  const clearCacheBtn = queryRequired<HTMLButtonElement>('#clear-cache-btn');
  const visionNowBtn = queryRequired<HTMLButtonElement>('#vision-now-btn');
  const clipboardNowBtn = queryRequired<HTMLButtonElement>('#clipboard-now-btn');
  const targetScoreSlider = queryRequired<HTMLInputElement>('#target-score');
  const consensusCheckbox = queryRequired<HTMLInputElement>('#consensus-mode');

  installValidationSync(form);
  bindPasswordToggle('#toggle-groq-key', '#groq-api-key', 'Groq API key');
  bindPasswordToggle('#toggle-gemini-key', '#gemini-api-key', 'Gemini API key');
  bindPasswordToggle(
    '#toggle-openrouter-key',
    '#openrouter-api-key',
    'OpenRouter API key'
  );
  bindPasswordToggle(
    '#toggle-mistral-key',
    '#mistral-api-key',
    'Mistral API key'
  );

  syncTargetScoreSliderUi();

  const statusResponse = await sendMessage<RuntimeStatusResponse>({
    type: 'GET_ENGINE_STATUS',
  });
  if (statusResponse && statusResponse.ok) {
    populateForm(statusResponse.settings);
    renderTelemetry(statusResponse.telemetry);
  }

  form
    .querySelectorAll<HTMLInputElement>('input[name="triggerMode"]')
    .forEach((radio) => {
      radio.addEventListener('change', async () => {
        const mode = radio.value as TriggerMode;
        const score = syncTargetScoreSliderUi();
        updateModeSubrowsVisibility(mode);
        await saveSettings({ triggerMode: mode, targetScore: score });
        showStatus(`Active mode: ${describeTriggerMode(mode, score)}.`);
      });
    });

  targetScoreSlider.addEventListener('input', () => {
    syncTargetScoreSliderUi();
  });

  targetScoreSlider.addEventListener('change', async () => {
    const score = syncTargetScoreSliderUi();
    await saveSettings({ targetScore: score, triggerMode: 'target_score' });
    const targetRadio = queryRequired<HTMLInputElement>('#mode-target-score');
    targetRadio.checked = true;
    updateModeSubrowsVisibility('target_score');
    showStatus(`Target Score set to ~${score} pts (±25).`);
  });

  document.querySelectorAll<HTMLButtonElement>('.preset-pill').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const presetScore = Number.parseInt(btn.dataset.score ?? '860', 10);
      const score = syncTargetScoreSliderUi(presetScore);
      const targetRadio = queryRequired<HTMLInputElement>('#mode-target-score');
      targetRadio.checked = true;
      updateModeSubrowsVisibility('target_score');
      await saveSettings({ targetScore: score, triggerMode: 'target_score' });
      showStatus(`Target Score preset active: ~${score} pts (±25).`);
    });
  });

  consensusCheckbox.addEventListener('change', async () => {
    const mode: ConsensusMode = consensusCheckbox.checked
      ? 'consensus_vote'
      : 'fastest_first';
    await saveSettings({ consensusMode: mode });
    showStatus(
      consensusCheckbox.checked
        ? 'Multi-AI Consensus Vote enabled (2+ AI vote check).'
        : 'Fastest Single AI mode enabled.'
    );
  });

  queryRequired<HTMLInputElement>('#engine-enabled').addEventListener(
    'change',
    async (e) => {
      const checked = (e.currentTarget as HTMLInputElement).checked;
      await saveSettings({ enabled: checked });
      showStatus(checked ? 'Engine active.' : 'Engine paused.');
    }
  );

  prefetchBtn.addEventListener('click', async () => {
    const quizInput = queryRequired<HTMLInputElement>('#quiz-id').value.trim();
    if (!extractUuid(quizInput) && !extractGamePin(quizInput)) {
      showStatus(
        'Enter a valid 5–10 digit PIN, Challenge link, or Quiz UUID.',
        true
      );
      return;
    }
    prefetchBtn.disabled = true;
    showStatus('Checking PIN / pre-fetching Challenge...');
    const response = await sendMessage<RuntimeCacheResponse>({
      type: 'PREFETCH_QUIZ_CACHE',
      quizIdInput: quizInput,
      openLivePinTab: true,
    });
    prefetchBtn.disabled = false;

    if (response && response.ok) {
      queryRequired<HTMLInputElement>('#quiz-id').value = response.quizId ?? '';
      if (response.livePinOnly && response.message) {
        showStatus(response.message);
      } else {
        showStatus(
          `Cached ${response.questionCount ?? 0} questions in Tier 1 memory.`
        );
      }
      const refreshed = await sendMessage<RuntimeStatusResponse>({
        type: 'GET_ENGINE_STATUS',
      });
      if (refreshed?.ok) {
        renderTelemetry(refreshed.telemetry);
      }
    } else {
      showStatus(response?.error ?? 'Unable to fetch quiz cache.', true);
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    await sendMessage<{ ok: boolean }>({ type: 'CLEAR_QUIZ_CACHE' });
    queryRequired<HTMLInputElement>('#quiz-id').value = '';
    const refreshed = await sendMessage<RuntimeStatusResponse>({
      type: 'GET_ENGINE_STATUS',
    });
    if (refreshed?.ok) {
      renderTelemetry(refreshed.telemetry);
    }
    showStatus('Tier 1 cache cleared.');
  });

  visionNowBtn.addEventListener('click', async () => {
    visionNowBtn.disabled = true;
    showStatus('Capturing tab & querying Vision AI...');

    const targetTab = await findPopupTargetKahootTab();

    const manualHash = buildQuestionStateHash(
      Date.now(),
      'popup-vision-trigger',
      [],
      'vision'
    );
    const result = await sendMessage<RuntimeResolveResponse>({
      type: 'TRIGGER_VISION_FALLBACK',
      stateHash: manualHash,
      questionIndex: -1,
      optionCount: 4,
      multiSelect: false,
    });
    visionNowBtn.disabled = false;

    if (result && result.ok && result.resolution) {
      if (targetTab && typeof targetTab.id === 'number') {
        const pushMsg: ContentPushMessage = {
          type: 'APPLY_RESOLVED_ANSWER',
          resolution: result.resolution,
        };
        try {
          await chrome.tabs.sendMessage(targetTab.id, pushMsg);
        } catch {
          void 0;
        }
      }
      const refreshed = await sendMessage<RuntimeStatusResponse>({
        type: 'GET_ENGINE_STATUS',
      });
      if (refreshed?.ok) {
        renderTelemetry(refreshed.telemetry);
      }
      showStatus(
        `Vision resolved choice [${result.resolution.indices.join(', ')}] in ${result.resolution.latencyMs}ms.`
      );
    } else {
      showStatus(result?.error ?? 'Vision capture failed.', true);
    }
  });

  clipboardNowBtn.addEventListener('click', async () => {
    clipboardNowBtn.disabled = true;
    showStatus('Reading clipboard & querying AI...');

    const targetTab = await findPopupTargetKahootTab();
    const clipHash = buildQuestionStateHash(
      Date.now(),
      'popup-clipboard-trigger',
      [],
      'vision'
    );
    const result = await sendMessage<RuntimeResolveResponse>({
      type: 'TRIGGER_CLIPBOARD_VISION',
      stateHash: clipHash,
      questionIndex: -1,
      optionCount: 4,
      multiSelect: false,
    });
    clipboardNowBtn.disabled = false;

    if (result && result.ok && result.resolution) {
      if (targetTab && typeof targetTab.id === 'number') {
        const applyMsg: ContentPushMessage = {
          type: 'APPLY_RESOLVED_ANSWER',
          resolution: result.resolution,
        };
        const toastMsg: ContentPushMessage = {
          type: 'CLIPBOARD_STATUS_TOAST',
          message: `⚡ Clipboard → [${result.resolution.indices.join(', ')}] (${result.resolution.latencyMs}ms)`,
        };
        try {
          await chrome.tabs.sendMessage(targetTab.id, applyMsg);
          await chrome.tabs.sendMessage(targetTab.id, toastMsg);
        } catch {
          void 0;
        }
      }
      const refreshed = await sendMessage<RuntimeStatusResponse>({
        type: 'GET_ENGINE_STATUS',
      });
      if (refreshed?.ok) {
        renderTelemetry(refreshed.telemetry);
      }
      showStatus(
        `Clipboard resolved choice [${result.resolution.indices.join(', ')}] in ${result.resolution.latencyMs}ms.`
      );
    } else {
      showStatus(result?.error ?? 'Clipboard Vision failed.', true);
    }
  });

  form.addEventListener('submit', async (event: SubmitEvent) => {
    event.preventDefault();
    const boundsOk = validateCrossFieldBounds();
    if (!boundsOk || !form.checkValidity()) {
      const firstInvalid = form.querySelector<HTMLElement>(':invalid');
      firstInvalid?.focus();
      showStatus('Fix highlighted validation errors before saving.', true);
      return;
    }

    saveBtn.disabled = true;
    const settingsPayload = readFormSettings();
    await saveSettings(settingsPayload);
    void sendMessage<{ ok: boolean }>({ type: 'WARMUP_CONNECTIONS' });

    if (
      settingsPayload.quizId &&
      (extractUuid(settingsPayload.quizId) ||
        extractGamePin(settingsPayload.quizId))
    ) {
      await sendMessage<RuntimeCacheResponse>({
        type: 'PREFETCH_QUIZ_CACHE',
        quizIdInput: settingsPayload.quizId,
        openLivePinTab: false,
      });
    }

    const refreshed = await sendMessage<RuntimeStatusResponse>({
      type: 'GET_ENGINE_STATUS',
    });
    if (refreshed?.ok) {
      renderTelemetry(refreshed.telemetry);
    }

    saveBtn.disabled = false;
    showStatus('Configuration saved & AI ensemble warmed.');
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEYS.TELEMETRY]?.newValue) {
      renderTelemetry(
        changes[STORAGE_KEYS.TELEMETRY].newValue as EngineTelemetry
      );
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  void initializePopup();
});
