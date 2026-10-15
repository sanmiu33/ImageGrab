/**
 * offscreen.js —— 离屏文档（chrome.offscreen 创建）
 *
 * Service Worker 里没有 XMLHttpRequest 和 <img>，当 SW 的 fetch 被源站拒绝
 * （403 防盗链等）时，由这里做二级、三级转换：
 *
 *  消息 EGRA_XHR_FETCH ：用 XMLHttpRequest(responseType='blob') 拉原图 → 转 dataURL 返回
 *  消息 EGRA_IMG_CANVAS ：用 <img crossOrigin> + <canvas> 加载并转 PNG → dataURL 返回
 *
 * 统一返回 { ok: true, dataUrl } 或 { ok: false, error }。
 * Blob 无法直接通过 chrome.runtime 消息传递（JSON 序列化），所以一律转 dataURL。
 */
'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'EGRA_XHR_FETCH') {
    xhrFetchAsDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // 异步响应
  }

  if (msg && msg.type === 'EGRA_IMG_CANVAS') {
    imgCanvasAsPngDataUrl(msg.url)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }

  return false;
});

/* ---------------------------------------------------------------------
 * 策略 B：XHR + responseType='blob'
 * ------------------------------------------------------------------- */

function xhrFetchAsDataUrl(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'blob';          // 直接拿二进制，避免文本乱码
    xhr.timeout = 30000;
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!xhr.response || xhr.response.size === 0) {
          reject(new Error('XHR 成功但响应为空'));
          return;
        }
        blobToDataUrl(xhr.response).then(resolve, reject);
      } else {
        reject(new Error(`XHR HTTP ${xhr.status}`)); // 403 防盗链会走到这里
      }
    };
    xhr.onerror = () => reject(new Error('XHR 网络错误'));
    xhr.ontimeout = () => reject(new Error('XHR 超时'));
    xhr.send();
  });
}

/* ---------------------------------------------------------------------
 * 策略 C：<img crossOrigin> + <canvas> 转 PNG
 * host_permissions 覆盖的域名走 crossOrigin='anonymous' 不会污染画布，
 * 可以直接 toBlob 导出真正的 PNG。
 * ------------------------------------------------------------------- */

function imgCanvasAsPngDataUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';        // 携带 CORS 请求，配合 host 权限可解污染
    img.referrerPolicy = 'no-referrer';   // 不带 Referer，绕过部分防盗链
    const timer = setTimeout(() => reject(new Error('<img> 加载超时(20s)')), 20000);

    img.onload = () => {
      clearTimeout(timer);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        // 一旦画布被污染，toBlob 会抛 SecurityError，由外层 catch 计入失败
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('canvas.toBlob 返回空')); return; }
          blobToDataUrl(blob).then(resolve, reject);
        }, 'image/png');
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error('<img> 加载失败（可能被防盗链拦截或格式不支持）'));
    };
    img.src = url;
  });
}

/* ---------------------------------------------------------------------
 * 工具：Blob → dataURL
 * ------------------------------------------------------------------- */

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Blob 转 dataURL 失败'));
    reader.readAsDataURL(blob);
  });
}
