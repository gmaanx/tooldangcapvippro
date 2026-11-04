# KahootHybridEngine

Extension trình duyệt chuẩn Manifest V3 (TypeScript + Vite) dành cho việc trích xuất câu hỏi, phân giải đáp án đa luồng và thực thi tương tác phần cứng (`isTrusted: true`) trên nền tảng Kahoot theo thời gian thực.

---

## Tổng quan kiến trúc

Hệ thống vận hành theo mô hình xử lý phân tầng (Multi-Tier Pipeline) nhằm tối ưu độ trễ và độ chính xác:

1. **Tier 1 — Pre-fetched Quiz & Self-Learning Cache (`0–5ms`)**
   - Trích xuất và lưu đệm bộ đề từ Kahoot REST API đối với các phiên có định danh (`kahoot.it/challenge/...` hoặc Quiz UUID).
   - Duy trì bộ nhớ đệm tự học cục bộ (LRU Cache tối đa 1.500 câu hỏi trong `chrome.storage.local`), đối chiếu theo văn bản đáp án chuẩn hóa nên không bị ảnh hưởng khi đảo thứ tự phương án. Tự động cập nhật đáp án chuẩn xác thực từ gói tin WebSocket của máy chủ sau mỗi câu hỏi.

2. **Tier 2 — WebSocket Interceptor, Score Pacer & CDP Trusted Clicker**
   - Đánh chặn luồng CometD WebSocket ở ngữ cảnh `MAIN` world để đọc thông số thời gian câu hỏi (`timeAvailableMs`) và đồng bộ dữ liệu giữa màn hình Host và Player.
   - Tính toán thời gian trễ ngược theo công thức tính điểm của Kahoot (`Target Score Pacing`) để kiểm soát mức điểm nhận được ở từng câu hỏi.
   - Thực thi sự kiện chuột mức trình duyệt (`Input.dispatchMouseEvent`) thông qua giao thức Chrome DevTools Protocol (`1.3`), đảm bảo thuộc tính `Event.isTrusted === true` trên cả câu hỏi đơn chọn và đa chọn (*Multi-select*).

3. **Tier 3 — Multi-Provider AI Consensus Engine**
   - Điều phối truy vấn bất đồng bộ song song qua 4 nhà cung cấp (**Groq**, **OpenRouter**, **Mistral AI**, **Google Gemini**) kết hợp nhiều họ mô hình độc lập (`Llama-4`, `Qwen-3`, `DeepSeek`, `Gemini Flash`, `Mistral Small`).
   - Áp dụng thuật toán bỏ phiếu đa số có trọng số (*Weighted Consensus Voting*) để chốt phương án tối ưu và loại trừ sai số từ từng mô hình đơn lẻ. Tích hợp fallback ngoại tuyến qua Chrome Built-in AI (`LanguageModel`) khi khả dụng.

4. **Tier 4 — Multimodal Vision & Clipboard Solver**
   - Nén ảnh qua `OffscreenCanvas` và phân giải trực tiếp từ ảnh chụp tab hiện tại hoặc dữ liệu Clipboard (hỗ trợ trường hợp màn hình người chơi bị ẩn nội dung câu hỏi).

---

## Cài đặt

### Phương án 1: Cài đặt trực tiếp từ bản đóng gói sẵn (`dist/`)

Kho lưu trữ đã bao gồm thư mục `dist/` được biên dịch sẵn, không yêu cầu cài đặt môi trường Node.js:

1. Tải mã nguồn về máy:
   ```bash
   git clone https://github.com/gmaanx/tooldangcapvippro.git
   ```
   Hoặc tải tệp nén qua nút **Code > Download ZIP** trên GitHub và giải nén ra thư mục cục bộ.
2. Mở trình duyệt nhân Chromium (Google Chrome, Microsoft Edge, Brave) và truy cập:
   ```text
   chrome://extensions
   ```
3. Kích hoạt tùy chọn **Developer mode** (Chế độ dành cho nhà phát triển) ở góc trên bên phải.
4. Nhấn **Load unpacked** (Tải tiện ích đã giải nén) và chọn đường dẫn trỏ trực tiếp vào thư mục **`dist`** nằm bên trong thư mục dự án.

> [!IMPORTANT]
> Phải chọn đúng thư mục con `dist/` (nơi chứa tệp `manifest.json` đã biên dịch), không chọn thư mục gốc của kho lưu trữ.

### Phương án 2: Biên dịch từ mã nguồn

Yêu cầu hệ thống: **Node.js >= 18.x** và **npm >= 9.x**.

```bash
npm install
npm run build
```

Sau khi quá trình biên dịch hoàn tất mà không có lỗi TypeScript, nạp thư mục `dist/` vào `chrome://extensions` hoặc nhấn **Reload** trên thẻ tiện ích nếu đã cài đặt trước đó.

---

## Cấu hình API Key

Mở giao diện điều khiển của tiện ích trên thanh công cụ trình duyệt và nhập khóa API vào các trường tương ứng. Khóa được lưu trữ cục bộ hoàn toàn trong `chrome.storage.local` và chỉ dùng để gửi yêu cầu HTTPS trực tiếp tới điểm cuối của nhà cung cấp tương ứng.

Hệ thống chỉ yêu cầu tối thiểu **01 API Key** (khuyến nghị **Groq**) để vận hành. Tuy nhiên, để cơ chế bỏ phiếu đa số (**Multi-AI Consensus Vote**) đạt độ tin cậy cao nhất, nên cấu hình từ **02 đến 04 API Key** dưới đây:

| Nhà cung cấp | Vai trò chính | Đường dẫn khởi tạo khóa (Free Tier) | Định dạng khóa |
| :--- | :--- | :--- | :--- |
| **Groq** | Xử lý văn bản tốc độ cao (`~150ms`) & Vision | https://console.groq.com/keys | `gsk_...` |
| **OpenRouter** | Định tuyến đa mô hình miễn phí (`openrouter/free`) | https://openrouter.ai/keys | `sk-or-v1-...` |
| **Mistral AI** | Xử lý văn bản (`mistral-small`) & ảnh (`pixtral-12b`) | https://console.mistral.ai/api-keys | Chuỗi ký tự |
| **Google Gemini** | Xử lý văn bản (`gemini-3.8-flash`) & Vision | https://aistudio.google.com/apikey | `AIza...` |

### Hướng dẫn chi tiết theo từng nhà cung cấp

1. **Groq (Khuyến nghị ưu tiên)**
   - Đăng nhập tại https://console.groq.com/keys, chọn **Create API Key**, đặt tên định danh và sao chép chuỗi `gsk_...` vào trường **Groq API Key**.

2. **OpenRouter**
   - Đăng nhập tại https://openrouter.ai/keys, chọn **Create Key** (không cần thiết lập thẻ thanh toán vì hệ thống chỉ gọi các điểm cuối miễn phí `:free`), sao chép khóa `sk-or-v1-...` vào trường **OpenRouter Key**.

3. **Mistral AI**
   - Đăng nhập tại https://console.mistral.ai/api-keys (chọn gói **Experiment / Free** nếu khởi tạo lần đầu), tạo khóa mới tại mục **API Keys** và dán vào trường **Mistral Key**.

4. **Google Gemini**
   - Truy cập https://aistudio.google.com/apikey, chọn **Create API key** và dán chuỗi `AIza...` vào trường **Gemini API Key**.

> [!WARNING]
> Đối với Google Gemini, bắt buộc khởi tạo API Key bằng **tài khoản Gmail cá nhân (`@gmail.com`)**. Các tài khoản Google Workspace thuộc tổ chức giáo dục (`.edu`, `.edu.vn`) thường bị giới hạn quyền truy cập gói miễn phí trên AI Studio và trả về lỗi `HTTP 403: The Gemini API free tier is not available for this project`.

---

## Chế độ vận hành & Phím tắt

### Chế độ thực thi (Action Mode)

Cấu hình trực tiếp tại mục **Action Mode** trong giao diện Popup (thay đổi có hiệu lực tức thời):

| Chế độ | Cơ chế hoạt động | Trường hợp sử dụng |
| :--- | :--- | :--- |
| `Target Score Auto-Click` | Đánh dấu viền vàng đáp án ngay khi phân giải xong (`0ms`), sau đó tính toán độ trễ dựa trên thời gian đếm ngược của câu hỏi để thực thi cú click đạt mức điểm mục tiêu (`600` – `980` điểm, kèm biên độ dao động ngẫu nhiên `±25` điểm). | Duy trì điểm số tự nhiên (khuyến nghị mức `~860` hoặc `~760`), tránh hiện tượng nhận tối đa `+1000` điểm liên tục ở mọi câu hỏi. |
| `Instant Auto-Click` | Thực thi click phần cứng ngay thời điểm nhận kết quả phân giải (`~150–300ms`). | Ưu tiên tốc độ phản hồi tối đa và điểm số tuyệt đối. |
| `Auto-Click + Human Delay` | Trì hoãn cú click theo khoảng thời gian ngẫu nhiên cố định (`Min ms` – `Max ms`) do người dùng chỉ định. | Kiểm soát cứng độ trễ phản xạ không phụ thuộc vào bộ đếm giờ của câu hỏi. |
| `Highlight Only` | Chỉ hiển thị khung viền vàng quanh phương án đúng, không kích hoạt `chrome.debugger` và không tự động click. | Người dùng chủ động chọn đáp án thủ công. |

### Tổ hợp phím tắt

Có thể tùy chỉnh lại tại `chrome://extensions/shortcuts`:

| Phím tắt | Chức năng |
| :--- | :--- |
| `Alt + Shift + Q` | Chụp khung hình tab Kahoot hiện tại và phân giải qua luồng Vision AI. |
| `Alt + Shift + V` | Đọc dữ liệu ảnh hoặc văn bản trong System Clipboard để phân giải và chọn đáp án. |
| `Ctrl + V` *(trên trang Kahoot)* | Dán trực tiếp ảnh chụp màn hình (ví dụ sau khi cắt vùng đề bằng `Win + Shift + S`) vào tab Kahoot để giải tức thời. |

---

## Lưu ý vận hành quan trọng

### 1. Cơ chế `chrome.debugger` và cách ẩn thanh thông báo gỡ lỗi của trình duyệt

Kahoot kiểm tra thuộc tính `Event.isTrusted` trên sự kiện chuột và loại bỏ các lời gọi `HTMLElement.prototype.click()` tổng hợp từ JavaScript thông thường. Để tạo sự kiện chuột phần cứng hợp lệ, tiện ích sử dụng giao thức `chrome.debugger`.

- Theo mặc định, hệ thống chỉ gắn kết nối gỡ lỗi khi phiên chơi bước vào màn hình câu hỏi thực tế (`/start`, `/getready`, `/gameblock`, `/answer`, `/challenge`) và **tự động ngắt kết nối ngay khi kết thúc ván đấu** (`/gameover`, `/ranking`, `/podium`) hoặc khi đang ở sảnh chờ nhập PIN (`/`, `/join`, `/instructions`).
- Trong thời gian diễn ra câu hỏi, **không nhấn `Cancel` (`Huỷ`) hoặc nút đóng (`×`)** trên thanh thông báo gỡ lỗi của trình duyệt, vì thao tác này sẽ thu hồi quyền điều khiển chuột của phiên hiện tại.

**Cấu hình ẩn hoàn toàn thanh thông báo gỡ lỗi trên Chrome (Tùy chọn):**

Chromium cung cấp cờ dòng lệnh chính thức `--silent-debugger-extension-api` để tắt thanh thông báo trên đối với các tiện ích tự động hóa:

1. Đóng toàn bộ tiến trình Google Chrome đang chạy (bao gồm cả tiến trình chạy nền dưới khay hệ thống Windows).
2. Nhấp chuột phải vào biểu tượng **Google Chrome** ngoài Desktop (hoặc trong Start Menu > *Open file location*), chọn **Properties**.
3. Tại thẻ **Shortcut**, tìm trường **Target** và nối thêm tham số `--silent-debugger-extension-api` vào sau dấu ngoặc kép đóng (cách nhau bởi một khoảng trắng):
   ```text
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
   ```
4. Nhấn **Apply** > **OK** và khởi chạy trình duyệt thông qua Shortcut vừa cấu hình.

### 2. Tránh xung đột với cửa sổ DevTools (`F12`)

Tại một thời điểm, Chromium chỉ cho phép một phiên Debugger duy nhất gắn vào một tab. Không mở cửa sổ Inspect (`F12`) trực tiếp trên tab `kahoot.it` đang diễn ra trò chơi khi sử dụng các chế độ Auto-Click.

### 3. Phân biệt phiên Live PIN và Challenge Link / UUID

- **Phiên chơi trực tiếp qua mã PIN (6–8 chữ số):** Máy chủ Kahoot không công khai trước danh sách câu hỏi qua mã PIN phòng trực tiếp. Người dùng không cần nhập UUID vào phần cài đặt mở rộng; chỉ cần tham gia phòng như bình thường, hệ thống sẽ tự động bắt câu hỏi ngay khi hiển thị và giải qua luồng Multi-AI Consensus.
- **Phiên bài tập (`kahoot.it/challenge/...`) hoặc đã có Quiz UUID:** Có thể dán đường dẫn hoặc UUID vào mục *Optional: Challenge Link, Live PIN & Notes* và nhấn **Load / Join** để nạp trước toàn bộ đáp án vào bộ nhớ đệm Tier 1 (`0ms`).

### 4. Xử lý chế độ ẩn nội dung câu hỏi trên thiết bị người chơi (Host-Only Display)

Trong trường hợp màn hình người chơi chỉ hiển thị 4 ô màu trắc nghiệm mà không kèm nội dung văn bản (đề bài chỉ chiếu trên máy chiếu hoặc qua Zoom / Google Meet / Microsoft Teams):

1. Sử dụng công cụ chụp vùng màn hình hệ điều hành (`Win + Shift + S` trên Windows hoặc `Cmd + Shift + Ctrl + 4` trên macOS) quét vùng chứa câu hỏi và các phương án trên cửa sổ họp trực tuyến.
2. Chuyển sang tab `kahoot.it` và nhấn `Ctrl + V` (hoặc nhấn `Alt + Shift + V`). Hệ thống sẽ trích xuất ảnh từ Clipboard, phân giải phương án đúng và tự động chọn ô màu tương ứng.

---

## Cấu trúc thư mục

```text
.
├── dist/                        # Bản biên dịch hoàn chỉnh dùng để nạp trực tiếp vào trình duyệt
├── public/
│   └── icons/                   # Tài nguyên biểu tượng tiện ích (16x16, 48x48, 128x128)
├── src/
│   ├── background/
│   │   ├── ai-racer.ts          # Điều phối truy vấn song song & bỏ phiếu đồng thuận đa mô hình
│   │   ├── clipboard-solver.ts  # Phân giải câu hỏi từ dữ liệu văn bản / hình ảnh trong Clipboard
│   │   ├── quiz-cache.ts        # Bộ nhớ đệm Tier 1 REST API & ngân hàng câu hỏi tự học (LRU)
│   │   ├── service-worker.ts    # Điều phối luồng sự kiện nền, vòng đời tab và tin nhắn nội bộ
│   │   ├── trusted-clicker.ts   # Quản lý kết nối CDP và phát sự kiện chuột phần cứng
│   │   └── vision-solver.ts     # Chụp khung hình hiển thị và phân giải đa phương thức
│   ├── content/
│   │   ├── content.ts           # Quan sát biến đổi DOM, đồng bộ trạng thái và điều tiết điểm số
│   │   └── injector.ts          # Đánh chặn luồng WebSocket/Fetch trong ngữ cảnh MAIN world
│   ├── offscreen/
│   │   ├── offscreen.html       # Tài liệu nền phục vụ xử lý đồ họa và truy cập Clipboard
│   │   └── offscreen.ts         # Thu phóng, nén ảnh JPEG qua OffscreenCanvas
│   ├── popup/
│   │   ├── index.html           # Giao diện cấu hình người dùng
│   │   ├── popup.css            # Định kiểu giao diện điều khiển
│   │   └── popup.ts             # Đồng bộ trạng thái cấu hình và thống kê độ trễ
│   └── shared/
│       ├── constants.ts         # Hằng số hệ thống và giá trị cấu hình mặc định
│       ├── normalize.ts         # Chuẩn hóa chuỗi, hàm băm câu hỏi và công thức tính trễ điểm số
│       ├── storage.ts           # Lớp truy xuất dữ liệu bền vững trên chrome.storage.local
│       └── types.ts             # Định nghĩa kiểu dữ liệu và giao thức thông điệp TypeScript
├── manifest.json                # Khai báo cấu hình và quyền hạn Manifest V3
├── package.json                 # Khai báo phụ thuộc và kịch bản biên dịch
├── tsconfig.json                # Cấu hình trình biên dịch TypeScript nghiêm ngặt
└── vite.config.ts               # Cấu hình đóng gói đa đầu vào (Popup, SW, Content IIFE)
```
