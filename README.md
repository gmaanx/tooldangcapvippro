# KahootHybridEngine

A Manifest V3 Chromium extension (TypeScript + Vite) engineered for real-time Kahoot question extraction, multi-provider parallel LLM consensus resolution, score-paced execution, and hardware-level trusted input dispatch (`Event.isTrusted === true`).

---

## Architecture Overview

The engine operates as a four-tier resolution pipeline designed to minimize latency while maintaining high answer accuracy:

1. **Tier 1 — Pre-fetched Quiz & Self-Learning Cache (`0–5ms`)**
   - Pre-fetches and indexes quiz payloads from Kahoot REST endpoints whenever a public Challenge URL (`kahoot.it/challenge/...`) or Quiz UUID is available.
   - Maintains a persistent local LRU question bank (up to 1,500 entries in `chrome.storage.local`) indexed by normalized choice text, remaining resilient to answer-order shuffling and self-updating from authoritative server WebSocket reveal frames.

2. **Tier 2 — WebSocket Interceptor, Score Pacer & CDP Trusted Clicker**
   - Intercepts CometD WebSocket frames in the `MAIN` execution world to capture question metadata (`timeAvailableMs`) and synchronize state between Host and Player tabs.
   - Computes inverse Kahoot score-decay delays (`Target Score Pacing`) so automated clicks land within a configurable point band rather than constantly scoring `+1000`.
   - Dispatches hardware-level mouse events (`Input.dispatchMouseEvent`) over Chrome DevTools Protocol (`1.3`), satisfying `Event.isTrusted === true` checks across both single-choice and multi-select rounds.

3. **Tier 3 — Multi-Provider AI Consensus Engine**
   - Executes concurrent low-latency inference across **Groq**, **Google Gemini**, and **OpenRouter**, spanning distinct model families (`Llama-4`, `Qwen-3`, `Gemini Flash`, `DeepSeek`).
   - Aggregates responses via weighted majority voting (*Multi-AI Consensus Vote*) to eliminate single-model hallucinations, with automatic offline fallback to Chrome Built-in AI (`LanguageModel`) when available.

4. **Tier 4 — Multimodal Vision & Clipboard Solver**
   - Compresses viewport captures and system clipboard images via `OffscreenCanvas` (`WebP`), racing multimodal vision models when question text is omitted from the student DOM.

---

## Installation

### Option 1: Load Pre-built Bundle (`dist/`)

The repository includes a production build inside `dist/`, allowing immediate installation without Node.js:

1. Clone or download this repository:
   ```bash
   git clone https://github.com/gmaanx/tooldangcapvippro.git
   ```
   Alternatively, click **Code > Download ZIP** on GitHub and extract the archive locally.
2. Open any Chromium-based browser (Google Chrome, Microsoft Edge, Brave) and navigate to:
   ```text
   chrome://extensions
   ```
3. Enable **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the **`dist`** directory located inside the extracted project folder.

> [!IMPORTANT]
> Select the `dist/` subdirectory (which contains the compiled `manifest.json`), not the repository root directory.

### Option 2: Build from Source

Prerequisites: **Node.js >= 18.x** and **npm >= 9.x**.

```bash
npm install
npm run build
```

Once compilation succeeds, load the generated `dist/` directory in `chrome://extensions` (or click **Reload** on the extension card if already installed).

---

## API Key Configuration

Open the **KahootHybridEngine** popup from the browser toolbar and enter your API keys under **2. Multi-AI Ensemble & API Keys**. All credentials are stored strictly locally in `chrome.storage.local` and are transmitted exclusively over HTTPS to their respective provider endpoints.

Only **one API key** (recommended: **Groq**) is required for operation. Configuring **two or all three providers** maximizes cross-model verification under **Multi-AI Consensus Vote**.

The providers below are listed in the exact order displayed in the extension interface:

| Order | Provider | Primary Role | Free API Key Console | Key Prefix |
| :--- | :--- | :--- | :--- | :--- |
| **1** | **Groq** | Ultra-low-latency text ensemble (`~150ms`) & Vision | https://console.groq.com/keys | `gsk_...` |
| **2** | **Google Gemini** | Multimodal text (`gemini-3.8-flash`) & Vision | https://aistudio.google.com/apikey | `AIza...` |
| **3** | **OpenRouter** | Free multi-model routing (`openrouter/free`, DeepSeek, Qwen) | https://openrouter.ai/keys | `sk-or-v1-...` |

### Step-by-Step Provider Setup

1. **Groq API Key (Recommended Primary)**
   - Sign in at https://console.groq.com/keys, click **Create API Key**, assign a name, and paste the generated `gsk_...` token into the **Groq API Key** field.

2. **Google Gemini API Key**
   - Sign in at https://aistudio.google.com/apikey, click **Create API key**, and paste the `AIza...` token into the **Gemini API Key** field.

> [!WARNING]
> Generate your Gemini API key using a **personal `@gmail.com` account**. Institutional or school Google Workspace accounts (`.edu`, `.edu.vn`) frequently restrict AI Studio Free Tier access and return `HTTP 403: The Gemini API free tier is not available for this project`.

3. **OpenRouter API Key**
   - Sign in at https://openrouter.ai/keys, click **Create Key** (no credit card or balance is required, as the engine exclusively targets `:free` endpoints), and paste the `sk-or-v1-...` token into the **OpenRouter API Key** field.

Click **Save Configuration** after entering your keys to persist settings and pre-warm TLS connections.

---

## Execution Modes & Keyboard Shortcuts

### Execution Modes

Configured under **1. Execution & Point Pacing** in the popup (changes apply immediately to active tabs):

| Mode | Behavior | Recommended Use Case |
| :--- | :--- | :--- |
| `Instant Auto-Click (+1000 pts)` | Dispatches a hardware-trusted click immediately upon answer resolution (`~150–300ms`). | Maximum speed and top possible score per question. |
| `Target Score Auto-Click (Stealth Points)` | Highlights the resolved option immediately (`0ms`), then calculates a dynamic wait interval scaled to the question countdown timer to hit your target score (`600`–`1000` pts with `±25` natural variance). | Classroom sessions where scoring `+1000` on every question is undesirable (presets: `~930`, `~860`, `~760`, `~660`). |
| `Custom Delay (ms)` | Waits a randomized interval bounded by `Min Delay (ms)` and `Max Delay (ms)` before clicking. | Fixed reaction-time simulation independent of question timer length. |
| `Highlight Only` | Renders a subtle gold outline around the correct choice without attaching `chrome.debugger` or clicking. | Manual clicking with zero browser debugger attachment. |

### Keyboard Shortcuts

Customizable at `chrome://extensions/shortcuts`:

| Shortcut | Action |
| :--- | :--- |
| `Alt + Shift + Q` | Captures the active Kahoot tab viewport and resolves the answer via Vision AI. |
| `Alt + Shift + V` | Reads an image or copied text from the system clipboard and resolves the corresponding Kahoot option. |
| `Ctrl + V` *(on Kahoot tab)* | Pastes a snipped screenshot directly into the active Kahoot page for immediate Vision resolution. |

---

## Operational Notes

### 1. `chrome.debugger` Lifecycle & Hiding the Browser Debugging Banner

Kahoot validates `Event.isTrusted` on pointer events and ignores synthetic `element.click()` calls. To dispatch genuine browser-level mouse input, the extension attaches `chrome.debugger` during automated click modes.

- **Automatic Lifecycle Management:** The extension does **not** attach the debugger on PIN entry or lobby screens (`/`, `/join`, `/instructions`). It attaches strictly during active question routes (`/start`, `/getready`, `/gameblock`, `/answer`, `/challenge`) and automatically detaches as soon as the match concludes (`/gameover`, `/ranking`, `/podium`).
- **Do not click `Cancel` or `×`** on Chrome's debugging infobar during an active question round, as doing so revokes trusted click permissions for that tab.

**Optional: Permanently Suppress the Debugging Infobar in Chrome**

Chromium provides the official `--silent-debugger-extension-api` launch switch to hide the debugging infobar completely:

1. Close all running Google Chrome windows (including background tray processes).
2. Right-click your **Google Chrome** desktop shortcut (or Start Menu shortcut via *Open file location*) and select **Properties**.
3. In the **Shortcut** tab, locate the **Target** field and append `--silent-debugger-extension-api` after the closing quotation mark (separated by a single space):
   ```text
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
   ```
4. Click **Apply** > **OK**, and launch Chrome using that shortcut.

### 2. Avoid DevTools (`F12`) Conflicts on the Active Game Tab

Chromium restricts each tab to a single active debugger session. Keep the `F12` DevTools inspector closed on the active `kahoot.it` tab while using Auto-Click modes.

### 3. Live Classroom PINs vs. Challenge Links / UUIDs

- **Live Classroom PINs (6–8 digits):** Live sessions stream questions one by one over WebSockets and do not expose a pre-game Quiz UUID. No optional setup is needed — join with the game PIN normally and the Multi-AI Consensus pipeline will resolve and click each question in real time.
- **Self-Paced Challenges (`kahoot.it/challenge/...`) or Known Quiz UUIDs:** Expand *Optional: Lecture Notes, Challenge Cache & Quick Join PIN* in the popup, paste the URL or UUID, and click **Join PIN / Cache Challenge** to pre-load `0ms` Tier 1 answers.

### 4. Host-Only Display Mode (Hidden Question Text on Player Devices)

When the host configures Kahoot to show only colored answer tiles on student screens while projecting questions over Zoom, Google Meet, Microsoft Teams, or a classroom projector:

1. Capture the projected question and choices into your clipboard (`Win + Shift + S` on Windows or `Cmd + Shift + Ctrl + 4` on macOS).
2. Switch to the `kahoot.it` tab and press `Ctrl + V` (or `Alt + Shift + V`). The clipboard vision solver will map the correct answer to its corresponding tile index (`0–3`) and execute the click automatically.

---

## Project Structure

```text
.
├── dist/                        # Pre-built production bundle ready for Chrome Load Unpacked
├── public/
│   └── icons/                   # Extension icons (16x16, 48x48, 128x128)
├── src/
│   ├── background/
│   │   ├── ai-racer.ts          # Parallel multi-provider inference & weighted consensus voting
│   │   ├── clipboard-solver.ts  # Image and text resolution from system clipboard payloads
│   │   ├── quiz-cache.ts        # Tier 1 REST pre-fetcher & persistent self-learning LRU bank
│   │   ├── service-worker.ts    # Background event router, tab lifecycle & message bus
│   │   ├── trusted-clicker.ts   # CDP debugger session manager & hardware mouse dispatcher
│   │   └── vision-solver.ts     # Visible-tab capture, WebP compression & multimodal solver
│   ├── content/
│   │   ├── content.ts           # DOM observer, state deduplication & target-score click pacer
│   │   └── injector.ts          # MAIN-world WebSocket/Fetch interceptor
│   ├── offscreen/
│   │   ├── offscreen.html       # Offscreen document host for canvas & clipboard operations
│   │   └── offscreen.ts         # OffscreenCanvas downscaling and clipboard extraction
│   ├── popup/
│   │   ├── index.html           # Extension configuration UI
│   │   ├── popup.css            # Popup stylesheet
│   │   └── popup.ts             # Settings synchronization, validation & live telemetry view
│   └── shared/
│       ├── constants.ts         # System constants, endpoints, model lists & defaults
│       ├── normalize.ts         # Text normalization, FNV-1a hashing & score-delay math
│       ├── storage.ts           # Persistent storage helpers for chrome.storage.local/session
│       └── types.ts             # Strict TypeScript interfaces and message contracts
├── manifest.json                # Chrome Extension Manifest V3 declaration
├── package.json                 # Build scripts and dependencies
├── tsconfig.json                # Strict TypeScript compiler configuration
└── vite.config.ts               # Multi-entry Vite bundler (Popup, Service Worker, Content IIFE)
```
