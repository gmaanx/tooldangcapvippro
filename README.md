# KahootHybridEngine

A Manifest V3 Chromium extension (TypeScript + Vite) engineered for real-time quiz question extraction, multi-provider parallel LLM consensus resolution, score-paced execution, focus-loss suppression, and hardware-level trusted input dispatch (`Event.isTrusted === true`) across **Kahoot** and **Wayground (Quizizz)**.

---

## Supported Platforms & Capabilities

| Platform | Supported Domains | Supported Question Formats & Features |
| :--- | :--- | :--- |
| **Kahoot** | `kahoot.it`, `play.kahoot.it`, `create.kahoot.it` | Single-Choice (`2-4` tiles), Multi-Select (`MSQ + Submit`), Challenge/UUID `0ms` pre-fetch, Host-Only Vision & Clipboard solving, Target Score stealth pacing |
| **Wayground (Quizizz)** | `wayground.com`, `quizizz.com`, `joinmyquiz.com` *(including subdomains)* | Single-Choice (`2-8` options), Multi-Select (`MSQ + Submit`), Fill-in-the-Blank / Short Text Auto-Type (single input & character-slot grids), KaTeX / MathJax formula extraction, Embedded Stem-Image Vision solving, Redemption Question `0ms` replay, Anti Focus-Loss (`Test Mode`) |

---

## Architecture Overview

The engine operates as a four-tier resolution pipeline designed to minimize latency while maintaining high answer accuracy:

1. **Tier 1 — Pre-fetched Quiz & Self-Learning Cache (`0-5ms`)**
   - Pre-fetches and indexes quiz payloads from Kahoot REST endpoints whenever a public Challenge URL (`kahoot.it/challenge/...`) or Quiz UUID is available.
   - Maintains a persistent local LRU question bank (up to 1,500 entries in `chrome.storage.local`) storing both normalized choice answers (resilient to option shuffling) and verified Fill-in-the-Blank strings, enabling `0ms` instant resolution on retakes and Wayground Redemption Questions.

2. **Tier 2 — Protocol Interceptor, Focus Guard, Score Pacer & CDP Input Dispatcher**
   - Intercepts Kahoot CometD WebSocket frames in the `MAIN` execution world to capture question timers (`timeAvailableMs`) and synchronize state between Host and Player tabs, while extracting KaTeX (`application/x-tex`) and MathJax (`aria-label`) expressions directly from Wayground DOM trees.
   - Installs a `document_start` focus guard on Wayground domains (`Anti Focus-Loss`) that neutralizes `visibilitychange`, `webkitvisibilitychange`, `mouseleave`, and window/document `blur` telemetry without interfering with internal `<input>` validation events.
   - Computes inverse score-decay delays (`Target Score Pacing`) so automated executions land within a configurable point band rather than constantly scoring maximum speed points.
   - Dispatches hardware-level mouse clicks (`Input.dispatchMouseEvent`) and native text insertion (`Input.insertText`) over Chrome DevTools Protocol (`1.3`), satisfying `Event.isTrusted === true` checks across single-choice, multi-select, and fill-in-the-blank rounds.

3. **Tier 3 — Multi-Provider AI Consensus Engine**
   - Executes concurrent low-latency inference across **Groq**, **Google Gemini**, and **OpenRouter**, spanning distinct model families (`Llama-4`, `Qwen-3`, `Gemini Flash`, `DeepSeek`) for both indexed choices (`0-7`) and exact-string fill-in-the-blank prompts.
   - Aggregates responses via weighted majority voting (*Multi-AI Consensus Vote*) to eliminate single-model hallucinations, with automatic offline fallback to Chrome Built-in AI (`LanguageModel`) when available.

4. **Tier 4 — Multimodal Vision & Clipboard Solver**
   - Compresses viewport captures and system clipboard images via `OffscreenCanvas` (`WebP`), racing multimodal vision models automatically when Wayground stems contain diagrams/formula images or when Kahoot runs in Host-Only display mode.

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

Open the **KahootHybridEngine** popup from the browser toolbar and enter your API keys under **2. Multi-AI Ensemble & API Keys**. All credentials are stored strictly locally in `chrome.storage.local` and are transmitted exclusively over HTTPS to their respective provider endpoints. Both Kahoot and Wayground share the same API key configuration.

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

## Execution Modes, Focus Protection & Shortcuts

### Execution Modes

Configured under **1. Execution & Point Pacing** in the popup (changes apply immediately to active Kahoot and Wayground tabs):

| Mode | Behavior | Recommended Use Case |
| :--- | :--- | :--- |
| `Instant Auto-Click (+1000 pts)` | Dispatches hardware-trusted option clicks (or auto-types and submits Fill-in-the-Blank answers) immediately upon resolution (`~150-300ms`). | Maximum speed and top possible score per question. |
| `Target Score Auto-Click (Stealth Points)` | Highlights the resolved option or previews the fill-blank answer immediately (`0ms`), then calculates a dynamic wait interval scaled to the question timer to hit your target score (`600`-`1000` pts with `+/-25` natural variance). | Live sessions where instantaneous maximum-score answers on every round are undesirable (presets: `~930`, `~860`, `~760`, `~660`). |
| `Custom Delay (ms)` | Waits a randomized interval bounded by `Min Delay (ms)` and `Max Delay (ms)` before clicking or typing. | Fixed reaction-time simulation independent of question timer length. |
| `Highlight Only` | Outlines the correct option(s) in gold (or displays a non-intrusive answer badge on Fill-in-the-Blank inputs) without attaching `chrome.debugger` or submitting. | Manual answering with zero browser debugger attachment. |

### Anti Focus-Loss (Wayground Test Mode)

Enabled by default in **1. Execution & Point Pacing**. When active on `wayground.com`, `quizizz.com`, and `joinmyquiz.com`, the `MAIN`-world guard overrides `Document.prototype.visibilityState`, `Document.prototype.hidden`, and `Document.prototype.hasFocus()`, and intercepts capture-phase window/document `blur`, `mouseleave`, and `visibilitychange` events so opening the extension popup or snipping screenshots does not trigger tab-switch warnings.

### Keyboard Shortcuts

Customizable at `chrome://extensions/shortcuts`:

| Shortcut | Action |
| :--- | :--- |
| `Alt + Shift + Q` | Captures the active Kahoot or Wayground tab viewport and resolves the answer via Vision AI. |
| `Alt + Shift + V` | Reads an image or copied text from the system clipboard and resolves the corresponding option or blank input. |
| `Ctrl + V` *(on active quiz tab)* | Pastes a snipped screenshot directly into an active Kahoot or Wayground page for immediate Vision resolution (ignored when typing inside a text input). |

---

## Operational Notes

### 1. `chrome.debugger` Lifecycle & Hiding the Browser Debugging Banner

Modern quiz frontends validate `Event.isTrusted` on pointer and keyboard events and ignore synthetic DOM calls. To dispatch genuine browser-level mouse clicks and `Input.insertText` keystrokes, the extension attaches `chrome.debugger` during automated modes.

- **Automatic Lifecycle Management:** The extension does **not** attach the debugger on PIN/code entry or lobby screens (`/`, `/join`, `/pro/join`, `/instructions`). It attaches strictly during active gameplay routes and automatically detaches as soon as the session reaches summary or leaderboard routes (`/gameover`, `/ranking`, `/podium`, `/summary`).
- **Do not click `Cancel` or `x`** on Chrome's debugging infobar during an active question round, as doing so revokes trusted click and auto-type permissions for that tab.

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

Chromium restricts each tab to a single active debugger session. Keep the `F12` DevTools inspector closed on the active `kahoot.it`, `wayground.com`, `quizizz.com`, or `joinmyquiz.com` tab while using Auto-Click / Auto-Type modes.

### 3. Live Classroom PINs / Game Codes vs. Kahoot Challenge UUIDs

- **Live Classroom PINs & Wayground Game Codes (`6-8` digits):** Live sessions stream questions dynamically and require zero pre-game setup. Join with your game code normally and the Multi-AI Consensus pipeline will detect, resolve, and execute each round automatically.
- **Kahoot Self-Paced Challenges (`kahoot.it/challenge/...`) or Known Quiz UUIDs:** Expand *Optional: Lecture Notes, Challenge Cache & Quick Join PIN* in the popup, paste the URL or UUID, and click **Join PIN / Cache Challenge** to pre-load `0ms` Tier 1 answers.

### 4. Visual Diagrams, Math Equations & Host-Only Screens

- **Wayground Stem Images & Formulas:** Embedded `.katex` and `mjx-container` formulas are converted into clean TeX strings before querying text models, while questions containing stem diagrams (`<img>`, `<svg>`, `<canvas>`) automatically invoke Multimodal Vision alongside DOM stem/option text.
- **Host-Only Projected Questions:** Capture the projected question into your clipboard (`Win + Shift + S` on Windows or `Cmd + Shift + Ctrl + 4` on macOS), switch to the quiz tab, and press `Ctrl + V` (or `Alt + Shift + V`).

---

## Project Structure

```text
.
├── dist/                        # Pre-built production bundle ready for Chrome Load Unpacked
├── public/
│   └── icons/                   # Extension icons (16x16, 48x48, 128x128)
├── src/
│   ├── background/
│   │   ├── ai-racer.ts          # Parallel multi-provider inference & consensus voting (choice + fill-blank)
│   │   ├── clipboard-solver.ts  # Image and text resolution from system clipboard payloads
│   │   ├── quiz-cache.ts        # Tier 1 REST pre-fetcher & persistent self-learning LRU bank
│   │   ├── service-worker.ts    # Background event router, tab lifecycle & message bus
│   │   ├── trusted-clicker.ts   # CDP debugger manager, hardware mouse clicker & text auto-typer
│   │   └── vision-solver.ts     # Visible-tab capture, WebP compression & multimodal solver
│   ├── content/
│   │   ├── content.ts           # Kahoot/Wayground DOM observer, KaTeX parser & score-paced executor
│   │   └── injector.ts          # MAIN-world WebSocket/Fetch proxy & Wayground focus-loss guard
│   ├── offscreen/
│   │   ├── offscreen.html       # Offscreen document host for canvas & clipboard operations
│   │   └── offscreen.ts         # OffscreenCanvas downscaling and clipboard extraction
│   ├── popup/
│   │   ├── index.html           # Extension configuration UI
│   │   ├── popup.css            # Popup stylesheet
│   │   └── popup.ts             # Settings synchronization, validation & live telemetry view
│   └── shared/
│       ├── constants.ts         # Platform selectors, API endpoints, model lists & defaults
│       ├── normalize.ts         # Hostname matchers, text/blank parsers, FNV-1a hashing & score math
│       ├── storage.ts           # Persistent storage helpers for chrome.storage.local/session
│       └── types.ts             # Strict TypeScript interfaces and message contracts
├── manifest.json                # Chrome Extension Manifest V3 declaration (v1.1.0)
├── package.json                 # Build scripts and dependencies
├── tsconfig.json                # Strict TypeScript compiler configuration
└── vite.config.ts               # Multi-entry Vite bundler (Popup, Service Worker, Content IIFE)
```
