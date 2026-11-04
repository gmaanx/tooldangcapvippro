import {
  VISION_MAX_DIMENSION_PX,
  VISION_WEBP_QUALITY,
} from '../shared/constants';
import type {
  ClipboardExtractedPayload,
  OffscreenClipboardRequest,
  OffscreenClipboardResponse,
} from '../shared/types';

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  const segments: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, offset + chunkSize);
    segments.push(String.fromCharCode(...slice));
  }
  return btoa(segments.join(''));
}

async function compressImageBlobToWebp(
  imageBlob: Blob
): Promise<{ base64: string; mimeType: 'image/webp' | 'image/png' | 'image/jpeg' }> {
  try {
    const bitmap = await createImageBitmap(imageBlob);
    const scale = Math.min(
      1,
      VISION_MAX_DIMENSION_PX / Math.max(bitmap.width, bitmap.height)
    );
    const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
    const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close();
      const fallbackBuf = await imageBlob.arrayBuffer();
      return {
        base64: arrayBufferToBase64(fallbackBuf),
        mimeType: imageBlob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
      };
    }

    ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const webpBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (blob) => resolve(blob),
        'image/webp',
        VISION_WEBP_QUALITY
      );
    });

    if (webpBlob) {
      const webpBuffer = await webpBlob.arrayBuffer();
      return {
        base64: arrayBufferToBase64(webpBuffer),
        mimeType: 'image/webp',
      };
    }
  } catch {
    void 0;
  }

  const rawBuffer = await imageBlob.arrayBuffer();
  return {
    base64: arrayBufferToBase64(rawBuffer),
    mimeType: imageBlob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png',
  };
}

async function extractClipboardPayload(): Promise<ClipboardExtractedPayload> {
  const pasteTarget = document.getElementById('clipboard-paste-target');
  let capturedBlob: Blob | null = null;
  let capturedText = '';

  if (pasteTarget) {
    pasteTarget.innerHTML = '';
    pasteTarget.focus();

    const handlePaste = (event: ClipboardEvent): void => {
      event.preventDefault();
      const data = event.clipboardData;
      if (!data) {
        return;
      }

      const items = Array.from(data.items ?? []);
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            capturedBlob = file;
            break;
          }
        }
      }

      const plainText = data.getData('text/plain');
      if (typeof plainText === 'string' && plainText.trim().length > 0) {
        capturedText = plainText.trim();
      }
    };

    document.addEventListener('paste', handlePaste);
    try {
      document.execCommand('paste');
    } finally {
      document.removeEventListener('paste', handlePaste);
      pasteTarget.innerHTML = '';
    }
  }

  if (capturedBlob) {
    const compressed = await compressImageBlobToWebp(capturedBlob);
    return {
      kind: 'image',
      base64: compressed.base64,
      mimeType: compressed.mimeType,
    };
  }

  if (capturedText.length > 0) {
    return {
      kind: 'text',
      text: capturedText,
    };
  }

  if (navigator.clipboard && typeof navigator.clipboard.read === 'function') {
    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const clipItem of clipboardItems) {
        const imageType = clipItem.types.find((t) => t.startsWith('image/'));
        if (imageType) {
          const blob = await clipItem.getType(imageType);
          const compressed = await compressImageBlobToWebp(blob);
          return {
            kind: 'image',
            base64: compressed.base64,
            mimeType: compressed.mimeType,
          };
        }
      }
    } catch {
      void 0;
    }
  }

  return { kind: 'empty' };
}

chrome.runtime.onMessage.addListener(
  (
    message: Partial<OffscreenClipboardRequest>,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: OffscreenClipboardResponse) => void
  ) => {
    if (
      message?.target !== 'OFFSCREEN_CLIPBOARD' ||
      message.type !== 'EXTRACT_CLIPBOARD_PAYLOAD'
    ) {
      return false;
    }

    (async () => {
      try {
        const payload = await extractClipboardPayload();
        sendResponse({ ok: true, payload });
      } catch (err) {
        sendResponse({
          ok: false,
          payload: { kind: 'empty' },
          error:
            err instanceof Error
              ? err.message
              : 'Offscreen clipboard read failed',
        });
      }
    })();

    return true;
  }
);
