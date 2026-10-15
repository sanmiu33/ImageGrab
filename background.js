/**
 * background.js —— MV3 Service Worker（下载与 PNG 转换，重构版）
 *
 * 图片转换链路（逐级降级，全部失败即判定该图下载失败）：
 *   A. ServiceWorker fetch（host_permissions 已覆盖各平台 CDN，无 CORS 限制）
 *   B. offscreen 离屏文档 XHR（responseType='blob'）
 *   C. offscreen 离屏文档 <img crossOrigin> + <canvas> 转 PNG
 *
 * 铁律：无论原图是 jpg / webp / avif / gif，
 *       最终交给 chrome.downloads.download 的一定是真 PNG Blob，
 *       文件名一定是「商品图_NNN.png」。
 *       任何一级都【不做】"直接下载原文件"的兜底——转换失败就报错并计入失败数。
 *
 * 其他职责：
 *   - 接收 content script 的图片列表 → 存 storage → 打开画廊页
 *   - 下载过程向画廊页推送进度与统计
 */

const OFFSCREEN_URL = 'offscreen.html';

/* ======================================================================
 * 消息路由
 * ==================================================================== */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // content script：提取完成 → 存列表 → 打开画廊页
  if (msg && msg.type === 'EGRA_OPEN_GALLERY') {
    chrome.storage.local.set({ images: msg.images || [] }, () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('gallery.html') });
    });
    sendResponse({ ok: true });
    return false;
  }

  // 画廊页：批量下载（异步处理，进度通过 tabs.sendMessage 推送）
  if (msg && msg.type === 'EGRA_DOWNLOAD') {
    handleDownload(msg.urls || [], sender.tab ? sender.tab.id : null);
    // 关键：必须立即应答 ack。若不应答，gallery 侧的
    // await chrome.runtime.sendMessage(...) 会因 "message port closed"
    // 被误判为"发送下载请求失败"；真正的下载在后台继续执行。
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/* ======================================================================
 * 批量下载（严格模式：非 PNG 不落盘）
 * ==================================================================== */

/**
 * @param {string[]} urls 画廊页勾选的原图 URL（按勾选顺序）
 * @param {number|null} tabId 画廊页标签页，用于回传进度
 */
async function handleDownload(urls, tabId) {
  const total = urls.length;
  let success = 0;
  let failed = 0;
  let lastError = '';

  for (let i = 0; i < total; i++) {
    // 文件名规则：商品图_001.png（序号补零 3 位）
    const filename = `商品图_${String(i + 1).padStart(3, '0')}.png`;
    try {
      const pngBlob = await obtainPngBlob(urls[i]);       // 三级策略，必须拿到真 PNG
      await saveBlob(pngBlob, filename);                  // downloads API 落盘
      success++;
    } catch (err) {
      failed++;
      lastError = String(err && err.message || err);
      // 按需求：转换失败必须报错，绝不默默下载原文件
      console.error(`[ImageGrab] 第 ${i + 1} 张转换失败：${urls[i]}\n原因：${lastError}`);
    }
    sendProgress(tabId, {
      type: 'EGRA_PROGRESS', done: i + 1, total, success, failed, lastError
    });
  }

  sendProgress(tabId, {
    type: 'EGRA_DONE', total, success, failed, lastError
  });
}

/** 向画廊页推送消息（画廊页可能已被关闭，静默忽略） */
function sendProgress(tabId, msg) {
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

/* ======================================================================
 * 三级转换策略：目标——拿到真·PNG Blob
 * ==================================================================== */

/**
 * 想尽一切办法把 url 对应的图片转成 PNG Blob。
 * 任一策略成功即返回；全部失败则抛出聚合错误（由调用方计失败并打印）。
 * @returns {Promise<Blob>} type 恒为 image/png
 */
async function obtainPngBlob(url) {
  const attempts = [];

  /* --- 策略 A：SW 内 fetch（3 组请求参数逐一尝试，绕 Referer/防盗链）--- */
  const fetchVariants = [
    { referrer: '', credentials: 'omit' },  // 完全不带 Referer（多数防盗链放行空 Referer）
    { credentials: 'omit' },                // 默认请求
    { credentials: 'include' }              // 携带 Cookie（需要登录态的接口图）
  ];
  for (const init of fetchVariants) {
    try {
      const blob = await fetchAsBlob(url, init);
      return await blobToPngBlob(blob);
    } catch (err) {
      attempts.push(`fetch(${Object.keys(init).join(',')}): ${err.message}`);
    }
  }

  /* --- 策略 B：offscreen 文档 XHR(responseType='blob') --- */
  try {
    await ensureOffscreen();
    const resp = await askOffscreen({ type: 'EGRA_XHR_FETCH', url });
    const blob = await dataUrlToBlob(resp.dataUrl);
    return await blobToPngBlob(blob);
  } catch (err) {
    attempts.push(`offscreen XHR: ${err.message}`);
  }

  /* --- 策略 C：offscreen 文档 <img crossOrigin> + canvas（直接产出 PNG）--- */
  try {
    await ensureOffscreen();
    const resp = await askOffscreen({ type: 'EGRA_IMG_CANVAS', url });
    const blob = await dataUrlToBlob(resp.dataUrl);
    if (blob.type !== 'image/png') throw new Error('canvas 产物不是 PNG');
    return blob;
  } catch (err) {
    attempts.push(`offscreen canvas: ${err.message}`);
  }

  throw new Error('三种转换策略全部失败 —— ' + attempts.join(' | '));
}

/**
 * fetch 拉取原图二进制，并做基本校验
 */
async function fetchAsBlob(url, init) {
  const resp = await fetch(url, init);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);       // 403 防盗链等
  const blob = await resp.blob();
  if (blob.size === 0) throw new Error('响应体为空');
  // 有些 CDN 不给 Content-Type，此时放行交给解码器验证；类型不对则立刻失败
  if (blob.type && !/^(image\/|application\/octet-stream)/i.test(blob.type)) {
    throw new Error(`非图片响应：${blob.type}`);
  }
  return blob;
}

/**
 * 任意格式(jpg/webp/avif/gif…)的图片 Blob → 真 PNG Blob
 * createImageBitmap 负责解码（含 AVIF），OffscreenCanvas 重新编码为 PNG。
 */
async function blobToPngBlob(blob) {
  if (blob.type === 'image/png') return blob;                 // 本来就是 PNG，直接用
  const bmp = await createImageBitmap(blob);                  // 解码失败会抛异常
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);  // 保持原始分辨率
  canvas.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close?.();
  const png = await canvas.convertToBlob({ type: 'image/png' });
  if (png.type !== 'image/png') throw new Error('convertToBlob 未产出 PNG');
  return png;
}

/* ======================================================================
 * offscreen 离屏文档管理
 * ==================================================================== */

/** 确保离屏文档已创建（SW 里没有 DOM，XHR/Canvas 都要在离屏文档里做） */
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('当前 Chrome 版本不支持 offscreen API');
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (contexts.length > 0) return; // 已存在
  } catch {
    // getContexts 需要 Chrome 116+；老版本直接尝试创建，重复创建会抛错，忽略即可
  }
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: '跨域商品图抓取与 PNG 转换（XHR / Canvas）'
    });
  } catch {
    // "Only a single offscreen document..." → 说明已存在，无需处理
  }
}

/** 给 offscreen 发消息并等待响应（callback 形式，便于拿到 lastError） */
function askOffscreen(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else if (!resp) {
        reject(new Error('offscreen 无响应'));
      } else if (!resp.ok) {
        reject(new Error(resp.error || 'offscreen 处理失败'));
      } else {
        resolve(resp);
      }
    });
  });
}

/** dataURL → Blob（SW 里可用 fetch(dataUrl) 直接转） */
async function dataUrlToBlob(dataUrl) {
  return await (await fetch(dataUrl)).blob();
}

/* ======================================================================
 * 落盘
 * ==================================================================== */

/** 把 PNG Blob 写入浏览器默认下载目录 */
async function saveBlob(pngBlob, filename) {
  if (pngBlob.type !== 'image/png') throw new Error('拒绝保存非 PNG 数据'); // 双保险
  const objUrl = URL.createObjectURL(pngBlob);
  try {
    await chrome.downloads.download({
      url: objUrl,
      filename,                   // 相对路径 = 默认下载目录
      conflictAction: 'uniquify'  // 重名自动加 (1)(2)…
    });
  } finally {
    // 下载任务已建立，延迟释放 blob URL 兜底回收内存
    setTimeout(() => URL.revokeObjectURL(objUrl), 120000);
  }
}
