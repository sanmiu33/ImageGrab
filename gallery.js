/**
 * gallery.js —— 画廊页逻辑（重构版）
 *
 * 职责：
 *  1. 从 chrome.storage.local 读取提取结果，网格展示（缩略图 + 尺寸 + 复选框）
 *  2. 缩略图强制 referrerpolicy="no-referrer" 加载，绕过 Referer 防盗链；
 *     加载失败/超时/尺寸偏小的卡片一律保留（只标记，绝不删除）
 *  3. 全选 / 反选 / 已选数量 / 下载选中
 *  4. 下载时把 URL 发给 background（三级转换 → 真 PNG），展示进度与结果
 */

/* ---------- 非扩展环境（直接打开 gallery.html 调试）的演示数据 ---------- */
const DEMO_IMAGES = [
  { url: 'https://picsum.photos/id/237/600/600' },
  { url: 'https://picsum.photos/id/238/800/500' },
  { url: 'https://picsum.photos/id/239/400/700' },
  { url: 'https://picsum.photos/id/240/500/500' },
  { url: 'https://picsum.photos/id/241/900/600' },
  { url: 'https://picsum.photos/id/242/300/300' }
];

/* ======================================================================
 * 状态与 DOM
 * ==================================================================== */

let images = [];             // [{ url, w, h }]
const selected = new Set();  // 已勾选的 URL

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const totalCountEl = document.getElementById('total-count');
const selectedCountEl = document.getElementById('selected-count');
const btnAll = document.getElementById('btn-all');
const btnInvert = document.getElementById('btn-invert');
const btnDownload = document.getElementById('btn-download');
const progressWrap = document.getElementById('progress-wrap');
const progressInner = document.getElementById('progress-inner');
const progressText = document.getElementById('progress-text');

/* ======================================================================
 * 初始化
 * ==================================================================== */

async function init() {
  // 显示构建版本号：用于确认浏览器里运行的是最新代码
  // （打开画廊页即可在标题旁看到 v1.2.0；旧版本代码没有这个标识）
  const VER = (typeof chrome !== 'undefined' && chrome.runtime?.getManifest)
    ? 'v' + chrome.runtime.getManifest().version
    : '演示模式';
  document.getElementById('build-ver').textContent = VER;
  console.log('[ImageGrab] gallery.js 已加载，版本:', VER);

  let list = null;

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    const data = await chrome.storage.local.get('images');
    list = data.images;
  }
  // 非扩展环境用演示数据预览 UI
  if ((!Array.isArray(list) || list.length === 0) &&
      (typeof chrome === 'undefined' || !chrome.storage?.local)) {
    list = DEMO_IMAGES;
  }

  images = (list || []).map((it) => ({ url: it.url, w: 0, h: 0 }));
  renderAll();
}

/* ======================================================================
 * 渲染
 * ==================================================================== */

function renderAll() {
  grid.innerHTML = '';
  images.forEach((item) => grid.appendChild(buildCard(item)));
  refreshCounts();
}

/** 构建单张卡片（移除时只删该卡片 DOM，不整页重渲染，避免闪烁与循环） */
function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.url = item.url; // 便于失败/过小时按 URL 精确移除

  const label = document.createElement('label');

  // 缩略图：关键属性 referrerpolicy="no-referrer"，
  // 请求不带 Referer，可绕过京东/淘宝 CDN 的防盗链，解决"一直加载中"
  const wrap = document.createElement('div');
  wrap.className = 'thumb-wrap';
  const img = document.createElement('img');
  img.setAttribute('referrerpolicy', 'no-referrer');   // 属性形式，确保随标签生效
  img.referrerPolicy = 'no-referrer';                  // 属性双向兜底
  img.loading = 'eager';                               // 立即加载，避免 lazy 配合失败后无回调
  img.alt = '商品图片预览';

  const sizeEl = document.createElement('span');
  sizeEl.className = 'card-size';
  sizeEl.textContent = '加载中…';

  // 15s 内既没 onload 也没 onerror（个别 CDN 挂起不响应）→ 标记失败（卡片保留）
  const timer = setTimeout(() => markFailed(item.url, '加载超时'), 15000);

  img.onload = () => {
    clearTimeout(timer);
    item.w = img.naturalWidth;
    item.h = img.naturalHeight;
    // 关键改动：绝不因尺寸小而删除卡片！只显示真实尺寸并做"偏小"标记，
    // 是否勾选、是否下载完全由用户决定（可能就是用户要的小尺寸商品图）
    const small = item.w < 100 || item.h < 100;
    sizeEl.textContent = `${item.w} × ${item.h}${small ? '（偏小）' : ''}`;
    if (small) card.classList.add('small');
  };
  img.onerror = () => {
    clearTimeout(timer);
    markFailed(item.url, '加载失败');
  };
  img.src = item.url;

  wrap.appendChild(img);

  // 底部：复选框 + 尺寸
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = selected.has(item.url);
  checkbox.addEventListener('click', (e) => e.stopPropagation()); // 防止与 label 联动双触发
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(item.url);
    else selected.delete(item.url);
    refreshCounts();
  });
  meta.appendChild(checkbox);
  meta.appendChild(sizeEl);

  label.appendChild(wrap);
  label.appendChild(meta);
  // <label> 包裹 checkbox：点击卡片任意位置即可切换勾选（浏览器原生行为）
  card.appendChild(label);
  return card;
}

/**
 * 标记加载失败的卡片：不删除！显示灰色占位图，
 * 复选框保持可用——预览失败 ≠ 下载会失败（预览被防盗链拦下时，background
 * 的三级转换链路仍可能成功抓到原图），所以用户仍然可以勾选并下载。
 */
function markFailed(url, reason) {
  const card = grid.querySelector(`.card[data-url="${CSS.escape(url)}"]`);
  if (!card) return;
  card.classList.add('load-failed');            // CSS 显示灰色占位样式
  const img = card.querySelector('img');
  if (img) img.remove();                        // 移除坏图元素，露出占位层
  const size = card.querySelector('.card-size');
  if (size) size.textContent = `${reason} · 仍可勾选下载`;
}

/** 刷新「已提取/已选」计数与下载按钮状态 */
function refreshCounts() {
  emptyEl.hidden = images.length > 0;
  totalCountEl.textContent = images.length;
  selectedCountEl.textContent = `已选 ${selected.size} 张`;
  btnDownload.disabled = selected.size === 0;
  btnDownload.textContent = `下载选中（${selected.size}）`;
}

/* ======================================================================
 * 工具栏事件
 * ==================================================================== */

btnAll.addEventListener('click', () => {
  selected.clear();
  images.forEach((it) => selected.add(it.url));
  grid.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
  refreshCounts();
});

btnInvert.addEventListener('click', () => {
  images.forEach((it) => {
    if (selected.has(it.url)) selected.delete(it.url);
    else selected.add(it.url);
  });
  grid.querySelectorAll('.card').forEach((card) => {
    const cb = card.querySelector('input[type="checkbox"]');
    cb.checked = selected.has(card.dataset.url);
  });
  refreshCounts();
});

// 下载选中：把 URL 交给 background 做「强制 PNG 转换」后下载
btnDownload.addEventListener('click', async () => {
  const urls = images.filter((it) => selected.has(it.url)).map((it) => it.url);
  if (!urls.length) return;

  btnDownload.disabled = true;
  progressWrap.hidden = false;
  setProgress(0, urls.length, '准备下载…');

  try {
    await chrome.runtime.sendMessage({ type: 'EGRA_DOWNLOAD', urls });
  } catch (err) {
    console.error('[ImageGrab] 发送下载请求失败：', err);
    progressText.textContent = `发送下载请求失败：${err?.message || err}`;
    btnDownload.disabled = selected.size === 0;
  }
});

function setProgress(done, total, text) {
  progressInner.style.width = total ? `${(done / total) * 100}%` : '0%';
  progressText.textContent = text;
}

/* ======================================================================
 * 接收 background 的进度 / 结果
 * ==================================================================== */

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'EGRA_PROGRESS') {
      const { done, total, success, failed, lastError } = msg;
      setProgress(done, total, `进度 ${done}/${total}｜PNG ${success}｜失败 ${failed}`);
      if (failed > 0 && lastError) console.warn('[ImageGrab] 最近失败原因：', lastError);
    } else if (msg.type === 'EGRA_DONE') {
      const { total, success, failed, lastError } = msg;
      if (failed > 0) {
        setProgress(total, total,
          `完成：PNG ${success} 张，失败 ${failed} 张（详见扩展控制台）`);
        if (lastError) console.error('[ImageGrab] 最后一次失败原因：', lastError);
      } else {
        setProgress(total, total, `完成！${success} 张图片已全部保存为 PNG`);
      }
      setTimeout(() => {
        progressWrap.hidden = true;
        btnDownload.disabled = selected.size === 0;
      }, 5000);
    }
  });
}

init();
