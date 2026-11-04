# ⚡ KahootHybridEngine

Tiện ích mở rộng (Chrome Extension — Manifest V3) hỗ trợ giải và tự động chọn đáp án Kahoot theo thời gian thực với cơ chế **Multi-AI Consensus (Đa AI cùng giải & bỏ phiếu)**, **Auto-Click chuột thật (`isTrusted: true`)**, và **Target Score Stealth Points (Tuỳ chỉnh điểm nhận được để tránh bị lộ)**.

---

## ✨ Tính năng nổi bật

- **🖱️ Auto-Click Chuột Thật (`isTrusted: true`)**: Mô phỏng thao tác nhấn chuột phần cứng qua Chrome DevTools Protocol (CDP), vượt qua cơ chế chặn click ảo của Kahoot trên cả câu chọn 1 đáp án lẫn câu chọn nhiều đáp án (*Multi-select*).
- **🎯 Tuỳ chỉnh điểm nhận được (`Target Score Auto-Click`)**: Thay vì câu nào cũng bấm tức thì `+1000` điểm dễ bị chú ý, tool vẫn tô viền vàng đáp án đúng ngay lập tức (`0ms`) nhưng **tự động căn đồng hồ đếm ngược của từng câu** (10s, 20s, 30s, 60s...) để trì hoãn cú click sao cho điểm nhận được rơi vào khoảng bạn chọn (`~660`, `~760`, `~860`, `~930` kèm độ lệch tự nhiên `±25` điểm như người thật).
- **🗳️ Đua tốc độ & Bỏ phiếu Đa AI (`Multi-AI Consensus Vote`)**: Kết hợp song song tới **4 nhà cung cấp AI miễn phí** (**Groq**, **OpenRouter**, **Mistral AI**, **Google Gemini**) và nhiều hệ model độc lập (`Llama-4`, `Qwen-3`, `DeepSeek`, `Gemini Flash`, `Mistral`). Đáp án được chốt theo đa số phiếu bầu có trọng số giúp giảm tối đa tỷ lệ chọn nhầm câu hỏi bẫy.
- **🧠 Ngân hàng Tự Học (`Learned Bank — 0ms`) & Pre-cache Challenge**: Tự động ghi nhớ các câu hỏi đã gặp và đáp án chuẩn xác thực từ máy chủ Kahoot (tối đa 1.500 câu, không sợ đảo vị trí đáp án A/B/C/D). Hỗ trợ tải trước 100% đáp án đối với link bài tập `kahoot.it/challenge/...` hoặc Quiz UUID.
- **📸 Giải qua Hình ảnh & Clipboard (`Alt+Shift+Q` / `Ctrl+V`)**: Hỗ trợ giải ngay cả khi giảng viên tắt hiển thị câu hỏi trên màn hình người chơi (chỉ chiếu đề qua Zoom/Google Meet/máy chiếu).

---

## 🚀 Hướng dẫn cài đặt Extension vào Chrome / Edge / Brave / Cốc Cốc

### Cách 1: Cài nhanh dùng ngay (Khuyên dùng — Không cần cài Node.js)

Trong kho lưu trữ này đã có sẵn thư mục **`dist/`** được đóng gói hoàn chỉnh:

1. Tải mã nguồn về máy:
   - Bấm nút xanh **`<> Code`** ở góc trên GitHub → chọn **`Download ZIP`**, sau đó **giải nén (Extract)** thư mục ra máy tính.
   - *(Hoặc dùng Git: `git clone https://github.com/gmaanx/tooldangcapvippro.git`)*
2. Mở trình duyệt Chrome (hoặc Edge / Brave / Cốc Cốc) và nhập vào thanh địa chỉ:
   ```text
   chrome://extensions
   ```
3. Bật công tắc **Chế độ dành cho nhà phát triển (*Developer mode*)** ở góc trên cùng bên phải.
4. Bấm nút **Tải tiện ích đã giải nén (*Load unpacked*)** ở góc trên bên trái.
5. Chọn đúng thư mục **`dist`** nằm bên trong thư mục bạn vừa giải nén (⚠️ **Lưu ý:** chọn thư mục `dist`, không chọn thư mục gốc bên ngoài).
6. Bấm biểu tượng mảnh ghép 🧩 trên thanh công cụ Chrome → bấm biểu tượng ghim 📌 cạnh **KahootHybridEngine** để tiện mở cài đặt.

### Cách 2: Tự build lại từ mã nguồn (Dành cho Developer)

Nếu bạn chỉnh sửa mã nguồn trong thư mục `src/`, hãy cài đặt [Node.js](https://nodejs.org/) (phiên bản 18 trở lên) và chạy:

```bash
npm install
npm run build
```

Sau khi lệnh chạy xong, quay lại trang `chrome://extensions` và bấm nút **Reload (🔄)** trên thẻ KahootHybridEngine.

---

## 🔑 Hướng dẫn lấy & cài đặt API Key miễn phí (4 nguồn AI)

Mở biểu tượng **KahootHybridEngine** trên thanh công cụ trình duyệt, dán API Key vào các ô tương ứng (hệ thống tự động lưu ngay khi dán).

> 💡 **Mẹo:** Bạn chỉ cần điền **tối thiểu 1 Key** (khuyên dùng **Groq**) là tool đã hoạt động đầy đủ. Tuy nhiên, nên điền **từ 2 đến 4 Key** và bật **Multi-AI Consensus Vote** để các AI kiểm chéo đáp án với nhau, đạt độ chính xác cao nhất! Toàn bộ API Key chỉ lưu cục bộ trên trình duyệt của bạn (`chrome.storage.local`).

### 1. Groq API Key *(Khuyên dùng số 1 — Miễn phí & Tốc độ nhanh nhất ~150ms)*
1. Truy cập: [https://console.groq.com/keys](https://console.groq.com/keys)
2. Đăng nhập bằng tài khoản Google hoặc GitHub.
3. Bấm nút **Create API Key** → đặt tên bất kỳ (ví dụ: `kahoot`) → bấm **Submit**.
4. Copy chuỗi mã bắt đầu bằng `gsk_...` và dán vào ô **Groq API Key** trong extension.

### 2. OpenRouter API Key *(Miễn phí — Tự động gọi các model `:free` như DeepSeek, Qwen, Llama)*
1. Truy cập: [https://openrouter.ai/keys](https://openrouter.ai/keys)
2. Đăng nhập bằng tài khoản Google.
3. Bấm **Create Key** → đặt tên bất kỳ → để trống phần Credit Limit (không cần nạp thẻ vì tool chỉ gọi router miễn phí `openrouter/free`) → bấm **Create**.
4. Copy chuỗi mã bắt đầu bằng `sk-or-v1-...` và dán vào ô **OpenRouter Key**.

### 3. Mistral AI API Key *(Miễn phí — Hỗ trợ cả giải chữ + giải ảnh Pixtral)*
1. Truy cập: [https://console.mistral.ai/api-keys](https://console.mistral.ai/api-keys)
2. Đăng nhập tài khoản (nếu lần đầu sử dụng, chọn gói **Experiment — Free** miễn phí).
3. Vào mục **API Keys** → bấm **Create new key** → copy mã vừa tạo dán vào ô **Mistral Key**.

### 4. Google Gemini API Key *(Hỗ trợ `gemini-3.8-flash` + Giải ảnh màn hình)*
1. Truy cập: [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Bấm **Create API key** → Copy chuỗi mã bắt đầu bằng `AIza...` dán vào ô **Gemini API Key**.
3. ⚠️ **LƯU Ý BẮT BUỘC VỚI GEMINI:** Hãy đăng nhập bằng **Gmail cá nhân (`@gmail.com`)** để tạo key. **TUYỆT ĐỐI KHÔNG dùng email trường học / tổ chức (`.edu`, `.edu.vn`...)** vì Google khoá gói Free Tier đối với Workspace giáo dục, dẫn tới lỗi `HTTP 403: The Gemini API free tier is not available for this project`.

---

## 🎮 Hướng dẫn chọn Chế độ chạy (Action Mode)

Trong cửa sổ Popup của extension, bạn có thể chuyển đổi linh hoạt giữa 4 chế độ bất kỳ lúc nào (áp dụng ngay lập tức không cần tải lại trang):

| Chế độ | Cách hoạt động | Khi nào nên dùng? |
| :--- | :--- | :--- |
| **Target Score Auto-Click (Stealth Points)** | Tô vàng đáp án ngay lập tức (`0ms`), sau đó tự tính toán thời gian chờ theo đồng hồ câu hỏi rồi mới click để lấy đúng mức điểm mục tiêu (`600` – `980` điểm, kèm nhiễu tự nhiên `±25` điểm). | Khuyên dùng trên lớp để lên top tự nhiên (ví dụ chọn mốc **`~860 Natural`** hoặc **`~760 Safe`**) mà không bị lộ câu nào cũng `+1000`. |
| **Instant Auto-Click (+1000 pts — Fastest)** | Tô vàng và tự động click chuột thật ngay khoảnh khắc có đáp án (`~150–300ms`). | Khi cần đua tốc độ tối đa lấy điểm tuyệt đối. |
| **Auto-Click + Human Delay** | Tự động click sau một khoảng trễ ngẫu nhiên cố định theo mili-giây (`Min ms` – `Max ms`) do bạn nhập. | Khi muốn cố định thời gian phản xạ (ví dụ chờ 1.2s – 2.5s sau khi hiện câu hỏi). |
| **Highlight Only (Manual Click)** | Chỉ tô khung viền vàng nổi bật quanh đáp án đúng, **không tự click** và **không bật chế độ gỡ lỗi trình duyệt**. | Khi bạn muốn tự tay bấm chọn đáp án và không muốn hiện bất kỳ thanh thông báo nào trên Chrome. |

---

## ⚠️ Các lưu ý cực kỳ quan trọng khi sử dụng

### 1. Về thanh thông báo `"KahootHybridEngine đã bắt đầu gỡ lỗi cho trình duyệt này"` (và cách ẩn 100%)
- **Vì sao thanh này xuất hiện?** Kahoot chặn toàn bộ các lệnh click bằng code thông thường (`element.click()` có `isTrusted: false`). Để tự động click ăn điểm như chuột thật (`isTrusted: true`), Chrome yêu cầu extension kết nối qua `chrome.debugger`.
- Tool đã được tối ưu tự động: **Không bật thanh này khi đang ở màn hình nhập PIN / sảnh chờ**, chỉ bật đúng lúc bắt đầu vào câu hỏi và **tự động tắt ngay khi kết thúc ván chơi**.
- **Không bấm nút `Huỷ` hoặc dấu `×`** trên thanh đó trong lúc đang diễn ra câu hỏi (vì bấm tắt sẽ ngắt quyền Auto-Click; nếu lỡ bấm thì đợi 8 giây hoặc đổi lại chế độ trong Popup để kết nối lại).

#### 🛠️ Cách ẩn hoàn toàn 100% thanh thông báo này vĩnh viễn trên Chrome:
Chrome hỗ trợ sẵn cờ dòng lệnh chính thức dành cho tiện ích tự động hoá. Bạn chỉ cần cài 1 lần duy nhất như sau:
1. **Đóng hoàn toàn mọi cửa sổ Google Chrome** đang chạy (kiểm tra cả khay hệ thống góc dưới bên phải màn hình, nếu còn biểu tượng Chrome thì chuột phải chọn *Exit*).
2. Ra màn hình **Desktop**, bấm chuột phải vào biểu tượng **Google Chrome** → chọn **Properties** *(nếu để Chrome dưới thanh Taskbar: bấm chuột phải vào icon Chrome → chuột phải tiếp vào dòng **Google Chrome** → chọn **Properties**)*.
3. Tại thẻ **Shortcut**, tìm ô **Target**. Đặt con trỏ vào **cuối cùng của dòng chữ** (sau dấu ngoặc kép `"`), nhấn **1 dấu cách (Space)** rồi dán thêm đoạn sau:
   ```text
   --silent-debugger-extension-api
   ```
   Ví dụ kết quả ô **Target** chuẩn sẽ trông như sau:
   ```text
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --silent-debugger-extension-api
   ```
4. Bấm **Apply** → **OK** (nếu Windows hỏi quyền Administrator thì bấm **Continue**).
5. Từ giờ hãy mở Chrome từ biểu tượng đó — thanh thông báo gỡ lỗi sẽ **biến mất hoàn toàn 100%** trong khi Auto-Click chuột thật vẫn hoạt động mượt mà!

### 2. Không mở bảng `F12` (DevTools) trên tab Kahoot đang chơi
Chrome chỉ cho phép duy nhất 1 bộ Debugger gắn vào 1 tab tại cùng thời điểm. Nếu bạn đang bật cửa sổ `F12` (Inspect) ngay trên tab `kahoot.it`, tính năng Auto-Click chuột thật sẽ bị xung đột. Hãy đóng `F12` trên tab chơi Kahoot trước khi vào trận.

### 3. Phân biệt Mã PIN trực tiếp trên lớp vs Link Challenge
- **Chơi Live bằng mã PIN (6–8 chữ số trên lớp):** Ở chế độ Live, máy chủ Kahoot giữ kín đề và chỉ gửi từng câu khi giảng viên bấm chiếu — vì vậy mã PIN không có sẵn bộ đề trước (không có UUID). Bạn **không cần điền gì vào mục Optional**, chỉ cần nhập PIN vào chơi bình thường, câu hỏi vừa hiện lên là dàn AI sẽ tự động đọc, bầu chọn đáp án và click ngay lập tức!
- **Chơi qua Link bài tập về nhà (`kahoot.it/challenge/...` hoặc biết trước UUID):** Mở mục *Optional: Challenge Link, Live PIN & Notes* dưới đáy Popup → dán link hoặc UUID vào và bấm **Load / Join** để nạp trước toàn bộ đáp án chuẩn (`Tier 1 Cache — 0ms`).

### 4. Xử lý khi giảng viên ẩn đề trên máy sinh viên (chỉ hiện 4 ô màu Đỏ / Xanh / Vàng / Lá)
Khi câu hỏi chỉ hiển thị trên màn hình chia sẻ Zoom / Google Meet / Teams hoặc máy chiếu:
- **Cách nhanh nhất (Khuyên dùng):** Nhấn `Win + Shift + S` quét vùng chứa câu hỏi và 4 đáp án trên màn hình Zoom/Meet → chuyển sang tab `kahoot.it` nhấn **`Ctrl + V`** (hoặc nhấn phím tắt **`Alt + Shift + V`**). AI Vision sẽ đọc ảnh từ Clipboard và tự động tô vàng + click đúng ô màu tương ứng!
- **Chụp trực tiếp tab đang mở:** Nhấn tổ hợp phím **`Alt + Shift + Q`**.
- *(Bạn có thể đổi phím tắt tuỳ ý tại trang `chrome://extensions/shortcuts`)*

---

## 📁 Cấu trúc thư mục dự án

```text
├── dist/                 # Bản build hoàn chỉnh (Dùng để Load unpacked trực tiếp vào Chrome)
├── public/icons/         # Bộ icon của Extension (16px, 48px, 128px)
├── src/
│   ├── background/       # Service Worker, Multi-AI Racer, CDP Trusted Clicker, Vision & Quiz Cache
│   ├── content/          # WebSocket Interceptor (MAIN world) & DOM Observer / Score Pacer (ISOLATED)
│   ├── offscreen/        # Offscreen Canvas nén ảnh siêu tốc & đọc Clipboard
│   ├── popup/            # Giao diện điều khiển Extension
│   └── shared/           # Hệ thống kiểu dữ liệu TypeScript, thuật toán tính điểm & lưu trữ
├── manifest.json         # Cấu hình Chrome Extension Manifest V3
├── package.json          # Cấu hình dependencies & scripts
├── tsconfig.json         # Cấu hình TypeScript nghiêm ngặt
└── vite.config.ts        # Cấu hình đóng gói đa luồng Vite
```
