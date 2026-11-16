# KahootHybridEngine

A Manifest V3 Chromium extension (TypeScript + Vite) engineered for real-time quiz question extraction, multi-provider parallel LLM consensus resolution, score-paced execution on **Kahoot** and **Wayground (Quizizz)**, and **strictly Highlight-Only** answer indication across **Universal LMS platforms and custom instructor websites**.

---

## Supported Platforms & Execution Policies

| Platform | Target Domains | Execution Policy | Supported Question Formats & Features |
| :--- | :--- | :--- | :--- |
| **Kahoot** | `kahoot.it`, `play.kahoot.it`, `create.kahoot.it` | Auto-Click / Target Score / Highlight | Single-Choice (`2-4` tiles), Multi-Select (`MSQ + Submit`), Challenge/UUID `0ms` pre-fetch, Host-Only Vision & Clipboard solving, Target Score stealth pacing |
| **Wayground (Quizizz)** | `wayground.com`, `quizizz.com`, `joinmyquiz.com` *(and subdomains)* | Auto-Click / Auto-Type / Target Score / Highlight | Single-Choice (`2-8` options), Multi-Select (`MSQ + Submit`), Fill-in-the-Blank / Short Text Auto-Type, KaTeX / MathJax formula extraction, Embedded Stem-Image Vision, Redemption `0ms` replay, Anti Focus-Loss (`Test Mode`) |
| **Universal LMS & Custom Web** | Moodle (`lms.*`), Canvas, Google Forms, Microsoft Forms, Blackboard, Azota, Shub, custom HTTP/HTTPS quiz apps | **Strictly Highlight-Only** *(Zero Auto-Click, Zero Auto-Submit, Zero Debugger)* | Single & Multi-Question pages (`2-12` options), Native Radio/Checkbox & ARIA (`radiogroup`) apps, Short-Answer hints, KaTeX / MathJax / LaTeX `alt` extraction, Moodle Review answer harvesting, **Gold Outline** & **Stealth Mode** (`CSS.highlights`), Selection & Manual Scan (`Alt+Shift+S`) |

---

## Architecture Overview

The engine operates as a four-tier resolution pipeline designed to minimize latency while maintaining high answer accuracy:

1. **Tier 1 — Pre-fetched Quiz & Self-Learning Cache (`0-5ms`)**
   - Pre-fetches and indexes quiz payloads from Kahoot REST endpoints whenever a public Challenge URL (`kahoot.it/challenge/...`) or Quiz UUID is available.
   - Maintains a persistent local LRU question bank (up to 1,500 entries in `chrome.storage.local`) storing normalized choice texts (resilient to option shuffling) and verified Fill-in-the-Blank strings, enabling `0ms` resolution on retakes, Wayground Redemption rounds, and repeated LMS attempts. Automatically harvests verified answers from Moodle quiz review pages (`.outcome .rightanswer`).

2. **Tier 2 — Platform Interceptors, Universal LMS Scanner & Scoped CDP Dispatcher**
   - **Kahoot & Wayground:** Intercepts Kahoot CometD WebSocket frames, installs a `document_start` Wayground focus guard (`Anti Focus-Loss`), computes inverse score-decay delays (`Target Score Pacing`), and dispatches hardware-level mouse clicks (`Input.dispatchMouseEvent`) and text insertion (`Input.insertText`) over Chrome DevTools Protocol (`1.3`).
   - **Universal LMS & Custom Websites (`universal-lms.ts`):** Runs at `document_end` with automatic course breadcrumb grounding (`pageContext`), pre-warming TLS connections on quiz lobby pages, and dispatching multi-question exams in concurrent super-batches (`6` questions/batch, up to `30` questions simultaneously in `~1.0-1.8s`). Any non-unanimous question automatically triggers a secondary **Surgical Arbiter** pass (`gemini-4-argon` / `gemini-3.8-flash` high-thinking + `gpt-oss-120b` + `qwen3.8-27b`) while enforcing a hard **Highlight-Only** boundary (`chrome.debugger` never attaches outside Kahoot and Wayground).

3. **Tier 3 — Multi-Provider AI Consensus Engine**
   - Executes concurrent low-latency inference across **Groq**, **Google Gemini**, and **OpenRouter**, spanning distinct model families (`Llama-4`, `Qwen-3`, `Gemini Flash`, `DeepSeek`) for both indexed choices (`0-11`) and exact-string fill-in-the-blank prompts.
   - Aggregates responses via weighted majority voting (*Multi-AI Consensus Vote*) to eliminate single-model hallucinations, with automatic offline fallback to Chrome Built-in AI (`LanguageModel`) when available.

4. **Tier 4 — Multimodal Vision & Clipboard Solver**
   - Compresses viewport captures and system clipboard images via `OffscreenCanvas` (`WebP`), racing multimodal vision models when Wayground stems contain diagrams, when Kahoot runs in Host-Only display mode, or when manually invoked on visual exam pages.

---

## Installation

### Option 1: Load Pre-built Bundle (`dist/`)

The repository includes a production build inside `dist/`, allowing immediate installation without Node.js:

1. Clone or download this repository:
   ```bash
   git clone https://github.com/gmaanx/tooldangcapvippro.git
   ```
   Alternatively, click **Code > Download ZIP** on GitHub and extract the archive locally.
2. Open any Chromium-based browser (Google Chrome, Microsoft Edge, Brave, Arc) and navigate to:
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

Open the **KahootHybridEngine** popup from the browser toolbar and enter your API keys under **3. Multi-AI Ensemble & API Keys**. All credentials are stored strictly locally in `chrome.storage.local` and are transmitted exclusively over HTTPS to their respective provider endpoints. Kahoot, Wayground, and Universal LMS share the same API key configuration.

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

## Execution Modes, Highlight Styles & Shortcuts

### 1. Kahoot & Wayground Execution Modes

Configured under **1. Kahoot & Wayground Execution** in the popup (applies exclusively to Kahoot and Wayground; external websites always enforce Highlight-Only):

| Mode | Behavior | Recommended Use Case |
| :--- | :--- | :--- |
| `Instant Auto-Click (+1000 pts)` | Dispatches hardware-trusted option clicks (or auto-types Fill-in-the-Blank answers) immediately upon resolution (`~150-300ms`). | Maximum speed and top possible score on Kahoot & Wayground. |
| `Target Score Auto-Click (Stealth Points)` | Highlights the resolved option immediately (`0ms`), then calculates a dynamic wait interval scaled to the question timer to hit your target score (`600`-`1000` pts with `+/-25` natural variance). | Live sessions where instantaneous maximum-score answers on every round are undesirable. |
| `Custom Delay (ms)` | Waits a randomized interval bounded by `Min Delay (ms)` and `Max Delay (ms)` before clicking or typing. | Fixed reaction-time simulation independent of question timer length. |
| `Highlight Only` | Outlines the correct option(s) without attaching `chrome.debugger` or clicking. | Manual answering across all platforms. |

### 2. Universal LMS & Highlight Visual Styles

Configured under **2. Universal LMS & Highlight Style**:

| Style | Visual Rendering | Recommended Environment |
| :--- | :--- | :--- |
| `Gold Outline` | Renders a crisp amber-gold border and subtle background tint around winning choice rows, or a compact answer pill adjacent to short-answer inputs. | Personal study, self-paced online LMS quizzes, and remote sessions. |
| `Stealth Mode` | Uses the CSS Custom Highlight API (`CSS.highlights` / `::highlight()`) to apply a faint dotted underline directly to text ranges without inserting DOM nodes into choice labels, and suppresses all on-page toast notifications. | Proctored computer labs and lecture halls where high-contrast borders or popups are undesirable. |

### 3. Keyboard Shortcuts

Customizable at `chrome://extensions/shortcuts` (on macOS, `Alt` maps to `Option`):

| Shortcut | Action |
| :--- | :--- |
| `Alt + Shift + S` | Scans and highlights all quiz questions on the active LMS or custom instructor webpage (if text is selected with the mouse, solves the selected passage directly). |
| `Alt + Shift + Q` | Captures the active tab viewport and resolves the answer via Vision AI. |
| `Alt + Shift + V` | Reads an image or copied text from the system clipboard and resolves the corresponding answer. |
| `Ctrl + V` / `Cmd + V` | Pastes a snipped screenshot directly into the active quiz page for immediate Vision resolution (ignored when focused inside a text input). |

---

## Operational Notes

### 1. Strict Highlight-Only Isolation on External Websites

Outside `kahoot.it` and `wayground.com` / `quizizz.com` / `joinmyquiz.com`, the service worker and trusted clicker enforce a hard URL and platform lock:
- `chrome.debugger` **never** attaches on LMS portals or custom instructor websites, meaning Chrome's top debugging infobar will never appear on those sites.
- No synthetic clicks, form value mutations, or automatic submissions are ever dispatched on external pages.

### 2. `chrome.debugger` Banner Suppression (Optional, for Kahoot & Wayground Auto-Click)

When using Auto-Click / Auto-Type modes on Kahoot or Wayground, Chromium displays a debugging infobar while `chrome.debugger` is attached. You can optionally hide this banner browser-wide with Chromium's `--silent-debugger-extension-api` flag:

- **Windows:** Append `--silent-debugger-extension-api` to the Google Chrome shortcut **Target** field:
  ```text
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
  ```
- **macOS:** Quit Chrome (`Cmd + Q`) and launch via Terminal:
  ```bash
  open -a "Google Chrome" --args --silent-debugger-extension-api
  ```

### 3. Avoid DevTools (`F12`) Conflicts on Active Kahoot / Wayground Tabs

Chromium restricts each tab to a single active debugger session. Keep the `F12` DevTools inspector closed on active Kahoot or Wayground tabs while using Auto-Click modes.

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
│   │   ├── service-worker.ts    # Background router, highlight-only external lock & scan coordinator
│   │   ├── trusted-clicker.ts   # Kahoot/Wayground-scoped CDP debugger clicker & text auto-typer
│   │   └── vision-solver.ts     # Visible-tab capture, WebP compression & multimodal solver
│   ├── content/
│   │   ├── content.ts           # Kahoot/Wayground DOM observer, KaTeX parser & score-paced executor
│   │   ├── injector.ts          # Kahoot/Wayground MAIN-world WebSocket proxy & focus-loss guard
│   │   └── universal-lms.ts     # Highlight-only multi-adapter scanner for LMS & custom quiz websites
│   ├── offscreen/
│   │   ├── offscreen.html       # Offscreen document host for canvas & clipboard operations
│   │   └── offscreen.ts         # OffscreenCanvas downscaling and clipboard extraction
│   ├── popup/
│   │   ├── index.html           # Extension configuration UI
│   │   ├── popup.css            # Popup stylesheet
│   │   └── popup.ts             # Settings synchronization, page scan trigger & live telemetry view
│   └── shared/
│       ├── constants.ts         # Platform selectors, API endpoints, model lists & defaults
│       ├── normalize.ts         # Hostname matchers, text/blank parsers, FNV-1a hashing & score math
│       ├── storage.ts           # Persistent storage helpers for chrome.storage.local/session
│       └── types.ts             # Strict TypeScript interfaces and message contracts
├── manifest.json                # Chrome Extension Manifest V3 declaration (v1.3.0)
├── package.json                 # Build scripts and dependencies
├── tsconfig.json                # Strict TypeScript compiler configuration
└── vite.config.ts               # Multi-entry Vite bundler (Popup, Service Worker, Content IIFEs)
```
