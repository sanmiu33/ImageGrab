/**
 * main.js — 图提取官网交互脚本（原生 JS，零依赖）
 *
 * 功能：
 *  1. 移动端汉堡菜单开合（点外部/点链接自动收起）
 *  2. 滚动时导航栏吸顶阴影
 *  3. 锚点点击：关闭菜单 + 平滑滚动时预留吸顶导航高度
 *  4. IntersectionObserver：区块进入视口淡入上移（.reveal → .in-view）
 *  5. 导航当前区块高亮（滚动监听 scrollspy）
 *  6. Footer 年份自动更新
 */
(() => {
  'use strict';

  /* ---------- 1. 汉堡菜单 ---------- */
  const toggle = document.getElementById('navToggle');
  const menu = document.getElementById('navMenu');

  /** 切换菜单开合，并同步 aria 状态（无障碍） */
  function toggleMenu(force) {
    const open = typeof force === 'boolean' ? force : !menu.classList.contains('open');
    menu.classList.toggle('open', open);
    toggle.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭菜单' : '打开菜单');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();          // 防止冒泡触发下方 document 点击监听
    toggleMenu();
  });

  // 点击菜单里的链接后自动收起（移动端体验）
  menu.querySelectorAll('a').forEach((a) =>
    a.addEventListener('click', () => toggleMenu(false))
  );

  // 点击页面其他区域收起菜单
  document.addEventListener('click', (e) => {
    if (menu.classList.contains('open') && !menu.contains(e.target)) toggleMenu(false);
  });

  // Escape 键收起菜单（键盘可达性）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('open')) toggleMenu(false);
  });

  /* ---------- 2. 导航栏滚动阴影 ---------- */
  const navbar = document.getElementById('navbar');
  const onScrollNav = () => navbar.classList.toggle('scrolled', window.scrollY > 8);
  window.addEventListener('scroll', onScrollNav, { passive: true });
  onScrollNav();

  /* ---------- 3. 锚点平滑滚动（补偿吸顶导航高度） ---------- */
  // CSS 已有 scroll-behavior: smooth；这里用 scroll-margin-top 更简单可靠，
  // 见 style.css 中 section 的写法；此监听仅用于关闭移动端菜单（上面已处理）。

  /* ---------- 4. 滚动进入视口：淡入上移动画 ---------- */
  const revealEls = document.querySelectorAll('.reveal');

  // 不支持 IntersectionObserver 的老浏览器直接全部显示（优雅降级）
  if (!('IntersectionObserver' in window)) {
    revealEls.forEach((el) => el.classList.add('in-view'));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            revealObserver.unobserve(entry.target); // 只播放一次
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    revealEls.forEach((el) => revealObserver.observe(el));
  }

  /* ---------- 5. 导航当前区块高亮（scrollspy） ---------- */
  const navLinks = [...document.querySelectorAll('.nav-link')];
  // 需要观察的区块：导航里出现过的 section id
  const sectionIds = ['intro', 'features', 'install', 'download'];
  const sections = sectionIds
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  if ('IntersectionObserver' in window && sections.length) {
    const spyObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const id = entry.target.id;
          navLinks.forEach((link) => {
            // 链接 href 形如 #features，与区块 id 对应
            link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
          });
        });
      },
      // 视口上 35% ~ 下 55% 之间算"当前区块"
      { rootMargin: '-35% 0px -55% 0px', threshold: 0 }
    );
    sections.forEach((sec) => spyObserver.observe(sec));
  }

  /* ---------- 6. Footer 年份 ---------- */
  document.getElementById('year').textContent = new Date().getFullYear();
})();
