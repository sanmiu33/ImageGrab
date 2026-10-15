/**
 * content.js —— 注入「获取图片」悬浮按钮，并提取当前商品详情页中的商品图片
 *
 * 职责：
 *  1. 判断当前页面是否为商品详情页（淘宝/天猫/京东/拼多多含商家版），是则注入悬浮按钮
 *  2. 点击按钮后扫描页面图片：<img> 的 src / srcset / data-* 懒加载属性 / CSS 背景图
 *  3. 过滤图标、logo、占位图、过小图片；相对路径补全；按"原图分组"去重
 *  4. 通过 chrome.runtime.sendMessage 把 URL 列表交给 background（存 storage 并打开画廊页）
 */
(() => {
  'use strict';

  /* ======================================================================
   * 1. 详情页判定：仅在这些 URL 特征匹配时才显示按钮
   * ==================================================================== */

  // 各平台详情页 URL 特征（host + path 正则）。SPA 站点（如拼多多商家版）路径变化需重新判定。
  const DETAIL_PATTERNS = [
    // 淘宝 / 天猫：item.htm?id=xxx、detail.tmall.com、chaoshi.detail 等
    { host: /(^|\.)(taobao|tmall)\.com$/i,        path: /item\.htm|\/detail|\/item/i },
    // 京东：item.jd.com/100012043978.html、mall.jd.com 商品页等
    { host: /(^|\.)jd\.com$/i,                    path: /item.*\.html|product\/\d+/i },
    // 拼多多（含商家版 mms.pinduoduo.com）：goods / spu / 商品管理路径
    { host: /(^|\.)(pinduoduo|yangkeduo)\.com$/i, path: /goods|spu|商品|\/mms\//i }
  ];

  /** 当前页面是否是商品详情页 */
  function isDetailPage() {
    return DETAIL_PATTERNS.some(
      (p) => p.host.test(location.hostname) && p.path.test(location.href)
    );
  }

  /* ======================================================================
   * 2. 悬浮按钮：右下角固定，不遮挡页面操作
   * ==================================================================== */

  let btn = null;

  /** 创建 / 移除悬浮按钮（根据详情页判定结果） */
  function syncButton() {
    const shouldShow = isDetailPage();
    if (shouldShow && !btn) {
      btn = document.createElement('button');
      btn.id = 'egrab-btn';
      btn.type = 'button';
      btn.textContent = '获取图片';
      btn.title = '提取本页所有商品图片';
      btn.addEventListener('click', onGrabClick);
      document.documentElement.appendChild(btn);
    } else if (!shouldShow && btn) {
      btn.remove();
      btn = null;
    }
  }

  /** 按钮点击：提取图片并发送给 background */
  async function onGrabClick() {
    if (btn.classList.contains('egrab-loading')) return; // 防重复点击
    btn.classList.add('egrab-loading');
    btn.textContent = '提取中…';

    try {
      const images = collectImages();
      if (!images.length) {
        showToast('未在页面中找到商品图片');
        return;
      }
      // 把 URL 列表交给 ServiceWorker（它有 storage 权限并负责打开画廊页）
      await chrome.runtime.sendMessage({ type: 'EGRA_OPEN_GALLERY', images });
    } catch (err) {
      // 扩展被重新加载后，旧页面的 content script 会失效（context invalidated）
      console.error('[ImageGrab] 提取失败：', err);
      showToast('提取失败，请刷新页面后重试');
    } finally {
      if (btn) {
        btn.classList.remove('egrab-loading');
        btn.textContent = '获取图片';
      }
    }
  }

  /** 页面内轻提示（2 秒自动消失） */
  function showToast(text) {
    const old = document.getElementById('egrab-toast');
    if (old) old.remove();
    const tip = document.createElement('div');
    tip.id = 'egrab-toast';
    tip.textContent = text;
    document.documentElement.appendChild(tip);
    setTimeout(() => tip.remove(), 2000);
  }

  /* ======================================================================
   * 3. 图片提取
   * ==================================================================== */

  // 常见的懒加载属性（不同平台写法不同，逐个尝试做兼容）
  const LAZY_ATTRS = [
    'data-src', 'data-lazy-src', 'data-lazyload', 'data-original',
    'data-img', 'data-url', 'data-ks-lazyload', 'ks-lazyload'
  ];

  // URL 中出现这些关键词的基本都是装饰图，直接排除
  const NOISE_RE = /logo|icon|sprite|spacer|blank|placeholder|pixel|avatar|badge|favicon|loading|\.(svg|ico)(\?|$)/i;

  /**
   * 从 srcset 中挑选分辨率最大的候选地址
   * @param {string} srcset  如 "a.jpg 100w, b.jpg 500w"
   * @returns {string} 最佳候选 URL（可能为空）
   */
  function pickLargestFromSrcset(srcset) {
    if (!srcset) return '';
    let best = '';
    let bestW = -1;
    for (const part of srcset.split(',')) {
      const seg = part.trim().split(/\s+/);
      if (!seg[0]) continue;
      let w = 0;
      const desc = seg[1] || '';
      if (/w$/i.test(desc))       w = parseInt(desc, 10) || 0;      // "500w"
      else if (/x$/i.test(desc))  w = parseFloat(desc) * 1000;      // "2x"
      if (w > bestW) { bestW = w; best = seg[0]; }
    }
    return best || srcset.split(',')[0].trim().split(/\s+/)[0] || '';
  }

  /**
   * 生成"分组去重"的 key：去掉缩略图尺寸标记，
   * 让同一张原图的不同尺寸变体（缩略图/大图）归为一组，只保留最大那张
   */
  function baseKey(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      let p = u.pathname;
      // 淘宝风格：xxx.jpg_430x430q90.jpg → 只保留 xxx.jpg
      p = p.replace(/\.(jpe?g|png|webp|gif)(_\d+x\d+(q\d+)?|![\w-]+)?\.\w+$/i, '.$1');
      // 京东风格：/n1/s450x450_jfs/... → 去掉 s450x450_ 前缀（大图没有该前缀）
      p = p.replace(/\/s\d+x\d+_(?=jfs|img|shaidan)/i, '/');
      // 常见缩略后缀：_60x60.jpg、-200x200.png、.thumb.jpg
      p = p.replace(/[._-]\d+x\d+\.\w+$/i, '').replace(/\.(thumb|small|middle|mini)\.\w+$/i, '');
      return u.origin + p;
    } catch {
      return rawUrl;
    }
  }

  /** 从 URL 里猜测图片面积（用于同组内挑最大变体），猜不出返回 0 */
  function sizeHint(url) {
    // 通用：URL 里含 450x450 / s450x450_ 等
    const m = url.match(/(\d{2,4})x(\d{2,4})/);
    if (m) return Number(m[1]) * Number(m[2]);
    // 拼多多风格：/w/500 或 w=500（imageView2 缩放参数）
    const w = url.match(/\/w\/(\d{2,4})|\bw=(\d{2,4})/);
    if (w) { const side = Number(w[1] || w[2]); return side * side; }
    return 0;
  }

  /** 归一化单个 URL：跳过无效项、补全相对路径；有效返回绝对 URL，否则返回 null */
  function normalizeUrl(src) {
    if (!src || typeof src !== 'string') return null;
    src = src.trim();
    // 内联 / 动态生成的图直接忽略（基本都是装饰图或 1x1 埋点图）
    if (/^(data:|blob:|about:)/i.test(src)) return null;
    if (NOISE_RE.test(src)) return null;
    try {
      return new URL(src, location.href).href; // 相对路径 / //xxx 补全为绝对地址
    } catch {
      return null;
    }
  }

  /**
   * 扫描页面，返回去重后的图片 URL 列表
   * @returns {Array<{url: string}>}
   */
  function collectImages() {
    const best = new Map(); // baseKey -> { url, hint }

    /** 记录一个候选 URL，同组内优先保留"原图"（无尺寸参数），其次保留面积最大的变体 */
    const add = (raw) => {
      const url = normalizeUrl(raw);
      if (!url) return;
      const key = baseKey(url);
      const hint = sizeHint(url);
      // 没有尺寸参数的 URL 视为原图，优先级最高；有参数的按面积比较
      const score = hint > 0 ? hint : Number.MAX_SAFE_INTEGER;
      const prev = best.get(key);
      if (!prev || score > prev.score) best.set(key, { url, score });
    };

    /* --- 3.1 <img> 标签：src / srcset / 各类懒加载属性 --- */
    document.querySelectorAll('img').forEach((img) => {
      // 已完成加载的图可用渲染尺寸过滤掉极小的图（1x1 埋点图等）。
      // 阈值放宽为 50×50：只拦截真正的装饰图/埋点图，
      // 避免把小尺寸的真实商品图（如色卡、细节图）在提取阶段就误杀。
      const tiny =
        img.complete && img.naturalWidth > 0 &&
        (img.naturalWidth < 50 || img.naturalHeight < 50);
      if (tiny) return;

      add(pickLargestFromSrcset(img.getAttribute('srcset'))); // srcset 里挑最大的
      add(img.getAttribute('src') || img.currentSrc);
      for (const attr of LAZY_ATTRS) add(img.getAttribute(attr)); // 各平台懒加载属性
    });

    /* --- 3.2 CSS 背景图（轮播图、hover 大图常这么做）--- */
    document.querySelectorAll('*').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') return;
      const re = /url\((['"]?)(.*?)\1\)/g;
      let m;
      while ((m = re.exec(bg)) !== null) add(m[2]);
    });

    /* --- 3.3 <style> 内联样式里的背景图 --- */
    document.querySelectorAll('style').forEach((tag) => {
      const re = /url\((['"]?)([^'")]+)\1\)/g;
      let m;
      while ((m = re.exec(tag.textContent || '')) !== null) add(m[2]);
    });

    return Array.from(best.values()).map((v) => ({ url: v.url }));  }

  /* ======================================================================
   * 4. 启动：SPA 路由变化时也要重新判定按钮显隐
   * ==================================================================== */

  // 包一层 history.pushState / replaceState，监听 SPA 页内跳转
  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function (...args) {
      const ret = orig.apply(this, args);
      syncButton();
      return ret;
    };
  });
  window.addEventListener('popstate', syncButton);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncButton);
  } else {
    syncButton();
  }
})();
