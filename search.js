/**
 * Gridea 极速全站搜索引擎 (L1 秒级热索引 + L2 Web Worker 分片全文检索)
 * 支持：
 * 1. 全站顶部菜单「搜索 (⌘K)」居中搜索面板（支持 ⌘K / Ctrl+K / 斜杠 / 唤起、↑↓ 键盘导航、回车直达）
 * 2. 归档页 (/archives/) 顶部常驻搜索框，跨分页原位按年份实时过滤全站 580+ 篇文章
 * 3. 「全部 (标题+全文)」与「仅标题/标签」双模式实时切换 + 中文输入法 IME 防抖优化
 */
(function () {
  'use strict';

  if (window.__GRIDEA_SEARCH_INITIALIZED__) return;
  window.__GRIDEA_SEARCH_INITIALIZED__ = true;

  const isMac = /Mac|iPod|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
  const shortcutLabel = isMac ? '⌘K' : 'Ctrl K';

  // 核心索引状态
  let metaLoaded = false;
  let metaLoadingPromise = null;
  let indexVersion = '';
  let totalPosts = 0;
  let chunkCount = 0;
  let posts = []; // 预处理后的 L1 条目
  let topTags = [];

  // Web Worker 实例与回调注册
  let searchWorker = null;
  let workerSupported = typeof window.Worker !== 'undefined';
  let reqSeq = 0;
  const pendingBodyCallbacks = new Map(); // reqId -> callback(msg)

  // 无 Worker 降级缓存（如极端受限环境）
  const fallbackChunkCache = new Map();

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function tokenizeQuery(q) {
    if (!q) return [];
    const parts = String(q)
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    // 去重并限制最多 6 个分词防止恶意超长正则
    return Array.from(new Set(parts)).slice(0, 6);
  }

  function highlightText(rawText, tokens) {
    const safe = escapeHtml(rawText || '');
    if (!tokens || !tokens.length || !safe) return safe;
    // 先匹配长词避免子串截断，且对 HTML 实体字符做安全转义后再匹配
    const safeTokens = tokens
      .map(t => escapeHtml(t))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp);
    if (!safeTokens.length) return safe;
    const reg = new RegExp(`(${safeTokens.join('|')})`, 'gi');
    return safe.replace(reg, '<mark class="gs-mark">$1</mark>');
  }

  function initWorker() {
    if (!workerSupported || searchWorker) return;
    try {
      searchWorker = new Worker('/search-worker.js' + (indexVersion ? '?v=' + indexVersion : ''));
      searchWorker.onmessage = function (e) {
        const msg = e.data || {};
        if (msg.type === 'BODY_BATCH') {
          const cb = pendingBodyCallbacks.get(msg.reqId);
          if (cb) {
            cb(msg);
            if (msg.done) pendingBodyCallbacks.delete(msg.reqId);
          }
        }
      };
      searchWorker.onerror = function () {
        workerSupported = false;
        searchWorker = null;
      };
      searchWorker.postMessage({
        type: 'INIT',
        basePath: '',
        version: indexVersion,
        chunkCount: chunkCount,
        prewarmFirst: true
      });
    } catch (err) {
      workerSupported = false;
      searchWorker = null;
    }
  }

  function ensureMetaLoaded() {
    if (metaLoaded) return Promise.resolve(posts);
    if (metaLoadingPromise) return metaLoadingPromise;

    metaLoadingPromise = fetch('/search-meta.json')
      .then(res => {
        if (!res.ok) throw new Error('Failed to load search-meta.json');
        return res.json();
      })
      .then(data => {
        indexVersion = data.v || '';
        totalPosts = data.total || (data.posts ? data.posts.length : 0);
        chunkCount = data.chunkCount || 0;

        const tagFreq = Object.create(null);
        posts = (data.posts || []).map(item => {
          const tLower = (item.t || '').toLowerCase();
          const sLower = (item.s || '').replace(/-/g, ' ').toLowerCase();
          const gStr = (item.g || []).join(' ');
          const gLower = gStr.toLowerCase();
          const hLower = (item.h || '').toLowerCase();
          const aLower = (item.a || '').toLowerCase();

          (item.g || []).forEach(tag => {
            tagFreq[tag] = (tagFreq[tag] || 0) + 1;
          });

          return {
            i: item.i,
            t: item.t || '',
            s: item.s || '',
            url: '/post/' + item.s + '/',
            d: item.d || '',
            year: (item.d || '').slice(0, 4) || '其他',
            g: item.g || [],
            h: item.h || '',
            a: item.a || '',
            c: item.c || 0,
            tLower,
            sLower,
            gLower,
            hLower,
            aLower,
            titleBlob: tLower + '\n' + gLower + '\n' + sLower,
            metaBlob: tLower + '\n' + gLower + '\n' + sLower + '\n' + hLower + '\n' + aLower
          };
        });

        topTags = Object.keys(tagFreq)
          .sort((a, b) => tagFreq[b] - tagFreq[a])
          .slice(0, 12);

        metaLoaded = true;
        initWorker();
        return posts;
      })
      .catch(err => {
        metaLoadingPromise = null;
        console.error('[Search] 加载热索引失败:', err);
        return [];
      });

    return metaLoadingPromise;
  }

  /**
   * L1 内存毫秒级检索（标题 + 标签 + H2/H3 章节 + 摘要）
   */
  function searchL1(tokens, rawQuery, scope) {
    if (!tokens.length || !posts.length) return [];
    const orderedTokens = tokens.slice().sort((a, b) => b.length - a.length);
    const phraseLower = String(rawQuery || '').trim().toLowerCase();
    const isTitleOnly = scope === 'title';
    const results = [];

    for (let idx = 0; idx < posts.length; idx++) {
      const p = posts[idx];
      const blob = isTitleOnly ? p.titleBlob : p.metaBlob;

      let allHit = true;
      for (let k = 0; k < orderedTokens.length; k++) {
        if (blob.indexOf(orderedTokens[k]) === -1) {
          allHit = false;
          break;
        }
      }
      if (!allHit) continue;

      let score = 0;
      let matchType = 'body';
      let snippet = '';

      const inTitle = tokens.some(tk => p.tLower.indexOf(tk) !== -1);
      const allInTitle = tokens.every(tk => p.tLower.indexOf(tk) !== -1);
      const inTag = tokens.some(tk => p.gLower.indexOf(tk) !== -1);

      if (allInTitle) {
        score += 120;
        if (phraseLower.length > 1 && p.tLower.indexOf(phraseLower) !== -1) score += 80;
        if (p.tLower.indexOf(tokens[0]) === 0) score += 20;
        matchType = 'title';
      } else if (inTitle) {
        score += 75;
        matchType = 'title';
      }

      if (inTag) {
        score += 55;
        if (matchType !== 'title') matchType = 'tag';
      }

      if (!isTitleOnly) {
        const inHeading = p.hLower && tokens.some(tk => p.hLower.indexOf(tk) !== -1);
        const inAbstract = p.aLower && tokens.some(tk => p.aLower.indexOf(tk) !== -1);
        if (inHeading) {
          score += 38;
          if (matchType === 'body') matchType = 'heading';
          snippet = '章节：' + p.h;
        }
        if (inAbstract) {
          score += 22;
          if (!snippet) snippet = p.a;
        }
      }

      if (!snippet && p.a && !isTitleOnly) {
        snippet = p.a;
      }

      results.push({
        post: p,
        score,
        matchType,
        snippet
      });
    }

    results.sort((a, b) => b.score - a.score || a.post.i - b.post.i);
    return results;
  }

  /**
   * 降级模式下主线程异步检索全文分片（仅在 Worker 被禁用时兜底）
   */
  async function fallbackSearchBody(reqId, getLatestReqId, tokens, rawQuery, onBatch) {
    const orderedTokens = tokens.slice().sort((a, b) => b.length - a.length);
    const phraseLower = String(rawQuery || '').trim().toLowerCase();

    for (let c = 0; c < chunkCount; c++) {
      if (getLatestReqId() !== reqId) return;
      let entries = fallbackChunkCache.get(c);
      if (!entries) {
        try {
          const res = await fetch(`/search-chunks/chunk-${c}.json${indexVersion ? '?v=' + indexVersion : ''}`);
          const data = await res.json();
          entries = (data.items || []).map(e => ({
            i: e[0],
            body: e[1] || '',
            bodyLower: (e[1] || '').toLowerCase(),
            combinedLower: ((e[2] || '').toLowerCase() + ' ' + (e[1] || '').toLowerCase())
          }));
          fallbackChunkCache.set(c, entries);
        } catch (err) {
          entries = [];
        }
      }
      if (getLatestReqId() !== reqId) return;

      const hits = [];
      for (let j = 0; j < entries.length; j++) {
        const item = entries[j];
        if (!orderedTokens.every(tk => item.combinedLower.indexOf(tk) !== -1)) continue;
        const pos = item.bodyLower.indexOf(orderedTokens[0]);
        const start = pos > 36 ? pos - 36 : 0;
        const end = Math.min(item.body.length, (pos >= 0 ? pos : 0) + 82);
        const snippet = (start > 0 ? '…' : '') + item.body.slice(start, end).trim() + (end < item.body.length ? '…' : '');
        hits.push({ i: item.i, score: 14, snippet });
      }
      onBatch({
        reqId,
        hits,
        loadedCount: fallbackChunkCache.size,
        totalChunks: chunkCount,
        done: c === chunkCount - 1
      });
    }
  }

  /**
   * 统一发起双层检索：先同步返回 L1，再异步流式回调 L2 合并结果
   */
  async function executeSearch(rawQuery, scope, onUpdate) {
    const myReqId = ++reqSeq;
    const tStart = performance.now();
    const tokens = tokenizeQuery(rawQuery);

    if (!tokens.length) {
      onUpdate({
        emptyQuery: true,
        results: [],
        tokens: [],
        elapsedMs: 0,
        scanningBody: false
      });
      return;
    }

    await ensureMetaLoaded();
    if (myReqId !== reqSeq) return;

    const l1Results = searchL1(tokens, rawQuery, scope);
    const elapsedL1 = (performance.now() - tStart).toFixed(1);

    if (scope === 'title' || chunkCount === 0) {
      onUpdate({
        emptyQuery: false,
        results: l1Results,
        tokens,
        elapsedMs: elapsedL1,
        scanningBody: false,
        loadedChunks: chunkCount,
        totalChunks: chunkCount
      });
      return;
    }

    // 先将 L1 秒级结果渲染上屏
    const mergedMap = new Map();
    l1Results.forEach(r => mergedMap.set(r.post.i, r));

    onUpdate({
      emptyQuery: false,
      results: l1Results,
      tokens,
      elapsedMs: elapsedL1,
      scanningBody: true,
      loadedChunks: 0,
      totalChunks: chunkCount
    });

    const handleBatch = msg => {
      if (myReqId !== reqSeq) return;
      let changed = false;
      const incoming = msg.hits || [];
      for (let k = 0; k < incoming.length; k++) {
        const hit = incoming[k];
        const postObj = posts[hit.i];
        if (!postObj) continue;
        const existing = mergedMap.get(hit.i);
        if (!existing) {
          mergedMap.set(hit.i, {
            post: postObj,
            score: hit.score,
            matchType: 'body',
            snippet: hit.snippet
          });
          changed = true;
        } else {
          // 如果 L1 命中的摘要中没有包含关键词，用正文中精准命中的上下文片段补充
          const hasTokenInSnippet =
            existing.snippet &&
            tokens.some(tk => existing.snippet.toLowerCase().indexOf(tk) !== -1);
          if (!hasTokenInSnippet && hit.snippet) {
            existing.snippet = hit.snippet;
            changed = true;
          }
          existing.score += Math.min(hit.score, 16);
        }
      }

      if (changed || msg.done) {
        const combined = Array.from(mergedMap.values()).sort(
          (a, b) => b.score - a.score || a.post.i - b.post.i
        );
        onUpdate({
          emptyQuery: false,
          results: combined,
          tokens,
          elapsedMs: (performance.now() - tStart).toFixed(1),
          scanningBody: !msg.done,
          loadedChunks: msg.loadedCount,
          totalChunks: msg.totalChunks
        });
      }
    };

    initWorker();
    if (searchWorker) {
      pendingBodyCallbacks.set(myReqId, handleBatch);
      searchWorker.postMessage({
        type: 'SEARCH_BODY',
        reqId: myReqId,
        tokens,
        rawQuery
      });
    } else {
      fallbackSearchBody(myReqId, () => reqSeq, tokens, rawQuery, handleBatch);
    }
  }

  function badgeInfo(matchType) {
    switch (matchType) {
      case 'title':
        return { cls: 'gs-badge-title', text: '标题' };
      case 'tag':
        return { cls: 'gs-badge-tag', text: '标签' };
      case 'heading':
        return { cls: 'gs-badge-heading', text: '章节' };
      default:
        return { cls: 'gs-badge-body', text: '全文' };
    }
  }

  /* ==========================================================================
     UI 模块 1：顶部导航栏「搜索 ⌘K」按钮 + 全局居中搜索弹窗
     ========================================================================== */
  let modalBackdrop = null;
  let modalInput = null;
  let modalClearBtn = null;
  let modalStatus = null;
  let modalResultsBody = null;
  let modalScope = 'all';
  let modalCurrentResults = [];
  let modalCurrentTokens = [];
  let modalRenderLimit = 40;
  let modalSelectedIdx = 0;

  function mountHeaderButton() {
    const menuContainer = document.querySelector('.site-header .menu-container');
    if (!menuContainer) return;

    let btn = menuContainer.querySelector('.menu-search-btn');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-search-btn';
      btn.setAttribute('aria-label', '搜索全站文章');
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>' +
        '</svg>' +
        '<span>搜索</span>' +
        '<kbd class="menu-search-kbd">' + shortcutLabel + '</kbd>';
      menuContainer.appendChild(btn);
    } else {
      const kbd = btn.querySelector('.menu-search-kbd');
      if (kbd) kbd.textContent = shortcutLabel;
    }

    btn.addEventListener('mouseenter', () => ensureMetaLoaded(), { once: true });
    btn.addEventListener('click', () => openModal());
  }

  function buildModalDom() {
    if (modalBackdrop) return;

    modalBackdrop = document.createElement('div');
    modalBackdrop.className = 'gs-modal-backdrop';
    modalBackdrop.setAttribute('role', 'dialog');
    modalBackdrop.setAttribute('aria-modal', 'true');
    modalBackdrop.innerHTML =
      '<div class="gs-modal-panel">' +
        '<div class="gs-modal-header">' +
          '<svg class="gs-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>' +
          '</svg>' +
          '<input type="search" class="gs-modal-input" placeholder="搜索文章标题、标签、章节或全文细节（多词空格分隔）..." autocomplete="off" spellcheck="false" />' +
          '<button type="button" class="gs-clear-btn" title="清空输入" aria-label="清空">×</button>' +
          '<div class="gs-scope-switch" role="tablist" aria-label="搜索范围">' +
            '<button type="button" class="gs-scope-btn is-active" data-scope="all">标题+全文</button>' +
            '<button type="button" class="gs-scope-btn" data-scope="title">仅标题/标签</button>' +
          '</div>' +
          '<button type="button" class="gs-esc-btn" title="关闭弹窗">ESC</button>' +
        '</div>' +
        '<div class="gs-status-bar"><span class="gs-status-text">正在准备全站索引...</span><span class="gs-status-right"></span></div>' +
        '<div class="gs-results-body"></div>' +
        '<div class="gs-modal-footer">' +
          '<div class="gs-footer-shortcuts">' +
            '<span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>' +
            '<span><kbd>↵</kbd> 打开文章</span>' +
            '<span><kbd>ESC</kbd> 关闭</span>' +
          '</div>' +
          '<span>双层分级索引 · 秒级响应</span>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modalBackdrop);

    modalInput = modalBackdrop.querySelector('.gs-modal-input');
    modalClearBtn = modalBackdrop.querySelector('.gs-clear-btn');
    modalStatus = modalBackdrop.querySelector('.gs-status-bar');
    modalResultsBody = modalBackdrop.querySelector('.gs-results-body');

    // 点击遮罩关闭
    modalBackdrop.addEventListener('mousedown', e => {
      if (e.target === modalBackdrop) closeModal();
    });
    modalBackdrop.querySelector('.gs-esc-btn').addEventListener('click', closeModal);

    // 清空按钮
    modalClearBtn.addEventListener('click', () => {
      modalInput.value = '';
      modalClearBtn.classList.remove('is-visible');
      modalInput.focus();
      triggerModalSearch();
    });

    // 切换「标题+全文」与「仅标题/标签」
    modalBackdrop.querySelectorAll('.gs-scope-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        modalScope = btn.getAttribute('data-scope') || 'all';
        modalBackdrop.querySelectorAll('.gs-scope-btn').forEach(b => {
          b.classList.toggle('is-active', b === btn);
        });
        modalInput.placeholder =
          modalScope === 'title'
            ? '仅在全站文章标题与标签中精准检索...'
            : '搜索文章标题、标签、章节或全文细节（多词空格分隔）...';
        modalInput.focus();
        triggerModalSearch();
      });
    });

    // 中文输入法 IME 友好防抖
    let composing = false;
    let debounceTimer = null;
    modalInput.addEventListener('compositionstart', () => {
      composing = true;
    });
    modalInput.addEventListener('compositionend', () => {
      composing = false;
      modalClearBtn.classList.toggle('is-visible', modalInput.value.length > 0);
      triggerModalSearch();
    });
    modalInput.addEventListener('input', () => {
      modalClearBtn.classList.toggle('is-visible', modalInput.value.length > 0);
      if (composing) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(triggerModalSearch, 30);
    });

    // 弹窗内键盘上下键与回车导航
    modalInput.addEventListener('keydown', e => {
      if (e.isComposing) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveModalSelection(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveModalSelection(-1);
      } else if (e.key === 'Enter') {
        const items = modalResultsBody.querySelectorAll('.gs-result-item');
        const active = items[modalSelectedIdx];
        if (active && active.getAttribute('href')) {
          e.preventDefault();
          const href = active.getAttribute('href');
          if (e.metaKey || e.ctrlKey) {
            window.open(href, '_blank');
          } else {
            window.location.href = href;
          }
        }
      }
    });
  }

  function renderModalQuickPanel() {
    const statusLeft = modalStatus.querySelector('.gs-status-text');
    const statusRight = modalStatus.querySelector('.gs-status-right');
    statusLeft.textContent = metaLoaded
      ? `全站共 ${totalPosts} 篇技术文章已就绪`
      : '正在加载全站索引...';
    statusRight.innerHTML = '';

    if (!metaLoaded) {
      modalResultsBody.innerHTML = '<div class="gs-empty-state">正在加载全站文章索引...</div>';
      return;
    }

    const recentPosts = posts.slice(0, 6);
    let html = '<div class="gs-quick-panel">';
    if (topTags.length) {
      html += '<div class="gs-quick-section-title">热门标签速查</div><div class="gs-quick-tags">';
      topTags.forEach(tag => {
        html += `<button type="button" class="gs-quick-tag-chip" data-tag="${escapeHtml(tag)}"># ${escapeHtml(tag)}</button>`;
      });
      html += '</div>';
    }
    html += '<div class="gs-quick-section-title">最新发布文章</div>';
    recentPosts.forEach((p, idx) => {
      html +=
        `<a href="${escapeHtml(p.url)}" class="gs-result-item${idx === 0 ? ' is-selected' : ''}" data-idx="${idx}">` +
          `<div class="gs-result-top"><div class="gs-result-title">${escapeHtml(p.t)}</div></div>` +
          `<div class="gs-result-meta"><span>${escapeHtml(p.d)}</span>` +
            p.g.slice(0, 3).map(t => `<span class="gs-result-tag"># ${escapeHtml(t)}</span>`).join('') +
          `</div>` +
        `</a>`;
    });
    html += '</div>';
    modalResultsBody.innerHTML = html;
    modalSelectedIdx = 0;

    modalResultsBody.querySelectorAll('.gs-quick-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const tag = chip.getAttribute('data-tag') || '';
        modalInput.value = tag;
        modalClearBtn.classList.add('is-visible');
        modalInput.focus();
        triggerModalSearch();
      });
    });
  }

  function renderModalResultsList() {
    if (!modalCurrentResults.length) {
      modalResultsBody.innerHTML =
        '<div class="gs-empty-state">未找到匹配的文章，试试精简关键词或切换至「标题+全文」模式</div>';
      return;
    }

    const slice = modalCurrentResults.slice(0, modalRenderLimit);
    if (modalSelectedIdx >= slice.length) modalSelectedIdx = 0;

    let html = '';
    for (let i = 0; i < slice.length; i++) {
      const r = slice[i];
      const p = r.post;
      const b = badgeInfo(r.matchType);
      const selectedCls = i === modalSelectedIdx ? ' is-selected' : '';
      const tagsHtml = p.g
        .slice(0, 4)
        .map(t => `<span class="gs-result-tag"># ${highlightText(t, modalCurrentTokens)}</span>`)
        .join('');
      const snippetHtml = r.snippet
        ? `<div class="gs-result-snippet">${highlightText(r.snippet, modalCurrentTokens)}</div>`
        : '';

      html +=
        `<a href="${escapeHtml(p.url)}" class="gs-result-item${selectedCls}" data-idx="${i}">` +
          `<div class="gs-result-top">` +
            `<div class="gs-result-title">${highlightText(p.t, modalCurrentTokens)}</div>` +
            `<span class="gs-badge ${b.cls}">${b.text}</span>` +
          `</div>` +
          `<div class="gs-result-meta">` +
            `<span>${escapeHtml(p.d)}</span>` +
            tagsHtml +
          `</div>` +
          snippetHtml +
        `</a>`;
    }

    if (modalCurrentResults.length > modalRenderLimit) {
      const remain = modalCurrentResults.length - modalRenderLimit;
      html += `<button type="button" class="gs-load-more-btn">展开剩余 ${remain} 篇匹配结果</button>`;
    }

    modalResultsBody.innerHTML = html;

    const moreBtn = modalResultsBody.querySelector('.gs-load-more-btn');
    if (moreBtn) {
      moreBtn.addEventListener('click', () => {
        modalRenderLimit += 60;
        renderModalResultsList();
        modalInput.focus();
      });
    }
  }

  function moveModalSelection(delta) {
    const items = modalResultsBody.querySelectorAll('.gs-result-item');
    if (!items.length) return;
    items[modalSelectedIdx] && items[modalSelectedIdx].classList.remove('is-selected');
    modalSelectedIdx = (modalSelectedIdx + delta + items.length) % items.length;
    const target = items[modalSelectedIdx];
    if (target) {
      target.classList.add('is-selected');
      target.scrollIntoView({ block: 'nearest' });
    }
  }

  function triggerModalSearch() {
    const q = modalInput ? modalInput.value : '';
    modalRenderLimit = 40;
    modalSelectedIdx = 0;

    if (!q.trim()) {
      reqSeq++;
      renderModalQuickPanel();
      return;
    }

    executeSearch(q, modalScope, state => {
      if (state.emptyQuery) {
        renderModalQuickPanel();
        return;
      }
      modalCurrentResults = state.results;
      modalCurrentTokens = state.tokens;

      const statusLeft = modalStatus.querySelector('.gs-status-text');
      const statusRight = modalStatus.querySelector('.gs-status-right');
      const scopeDesc = modalScope === 'title' ? '仅标题/标签' : '标题 + 全文';
      statusLeft.textContent = `找到 ${state.results.length} 篇匹配文章（${scopeDesc} · ${state.elapsedMs} ms）`;

      if (state.scanningBody) {
        statusRight.innerHTML =
          `<span class="gs-status-scanning"><span class="gs-spinner"></span>扫描全文 (${state.loadedChunks}/${state.totalChunks})</span>`;
      } else {
        statusRight.textContent = modalScope === 'all' ? '全文扫描已完成' : '';
      }

      renderModalResultsList();
    });
  }

  async function openModal(initialQuery) {
    buildModalDom();
    modalBackdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';

    if (typeof initialQuery === 'string') {
      modalInput.value = initialQuery;
      modalClearBtn.classList.toggle('is-visible', initialQuery.length > 0);
    }

    setTimeout(() => modalInput && modalInput.focus(), 10);

    await ensureMetaLoaded();
    if (searchWorker && modalScope === 'all') {
      searchWorker.postMessage({ type: 'PREWARM_ALL' });
    }
    triggerModalSearch();
  }

  function closeModal() {
    if (!modalBackdrop || !modalBackdrop.classList.contains('is-open')) return;
    modalBackdrop.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  /* ==========================================================================
     UI 模块 2：归档页 (/archives/) 原位实时过滤搜索框（突破 100 篇分页限制）
     ========================================================================== */
  function mountArchiveInlineSearch() {
    const archivesContainer = document.querySelector('.archives-container');
    if (!archivesContainer) return;
    if (archivesContainer.querySelector('.archive-search-wrapper')) return;

    const paginationEl = document.querySelector('.pagination-container');

    // 将原有的静态年份与文章节点包裹进独立容器，清空搜索时零损耗秒恢复
    const staticListWrapper = document.createElement('div');
    staticListWrapper.className = 'archive-static-list';
    while (archivesContainer.firstChild) {
      staticListWrapper.appendChild(archivesContainer.firstChild);
    }

    const searchWrapper = document.createElement('div');
    searchWrapper.className = 'archive-search-wrapper';
    searchWrapper.innerHTML =
      '<div class="archive-search-bar">' +
        '<svg class="gs-search-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>' +
        '</svg>' +
        '<input type="search" class="archive-search-input" placeholder="在全站归档文章中实时搜索标题、标签或全文..." autocomplete="off" spellcheck="false" />' +
        '<button type="button" class="gs-clear-btn archive-clear-btn" title="清空筛选" aria-label="清空">×</button>' +
        '<div class="gs-scope-switch" role="tablist" aria-label="归档搜索范围">' +
          '<button type="button" class="gs-scope-btn is-active" data-scope="all">标题+全文</button>' +
          '<button type="button" class="gs-scope-btn" data-scope="title">仅标题</button>' +
        '</div>' +
      '</div>' +
      '<div class="archive-search-meta">' +
        '<span class="archive-status-left">输入关键词即可跨分页实时检索全站全部历史文章</span>' +
        '<span class="archive-status-right">快捷键 ' + shortcutLabel + '</span>' +
      '</div>';

    const liveResultsEl = document.createElement('div');
    liveResultsEl.className = 'archive-live-results';
    liveResultsEl.style.display = 'none';

    archivesContainer.appendChild(searchWrapper);
    archivesContainer.appendChild(liveResultsEl);
    archivesContainer.appendChild(staticListWrapper);

    const inputEl = searchWrapper.querySelector('.archive-search-input');
    const clearBtn = searchWrapper.querySelector('.archive-clear-btn');
    const statusLeft = searchWrapper.querySelector('.archive-status-left');
    const statusRight = searchWrapper.querySelector('.archive-status-right');
    let archiveScope = 'all';

    // 归档页打开后空闲预热全站热索引，更新真实总篇数提示
    ensureMetaLoaded().then(() => {
      if (!inputEl.value.trim()) {
        statusLeft.textContent = `全站共 ${totalPosts} 篇历史文章 · 输入关键词跨分页实时筛选`;
      }
    });

    function restoreStaticArchives() {
      reqSeq++;
      liveResultsEl.style.display = 'none';
      liveResultsEl.innerHTML = '';
      staticListWrapper.style.display = '';
      if (paginationEl) paginationEl.style.display = '';
      statusLeft.textContent = metaLoaded
        ? `全站共 ${totalPosts} 篇历史文章 · 输入关键词跨分页实时筛选`
        : '输入关键词即可跨分页实时检索全站全部历史文章';
      statusRight.textContent = '快捷键 ' + shortcutLabel;
    }

    function renderArchiveResults(results, tokens) {
      if (!results.length) {
        liveResultsEl.innerHTML =
          '<div class="gs-empty-state">没有找到符合条件的归档文章，请尝试其他关键词或切换「标题+全文」</div>';
        return;
      }

      // 归档视图按年份倒序分组呈现，同时保持组内按日期或相关度清晰展示
      const byYear = new Map();
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const y = r.post.year;
        if (!byYear.has(y)) byYear.set(y, []);
        byYear.get(y).push(r);
      }

      const sortedYears = Array.from(byYear.keys()).sort((a, b) => b.localeCompare(a));
      let html = '';
      sortedYears.forEach(year => {
        const group = byYear.get(year);
        // 每年内部按日期从新到旧排列，符合归档时间线心智
        group.sort((a, b) => a.post.i - b.post.i);
        html += `<h2 class="year">${escapeHtml(year)}<span class="year-count">(${group.length} 篇)</span></h2>`;
        group.forEach(r => {
          const p = r.post;
          const b = badgeInfo(r.matchType);
          const tagsHtml = p.g
            .slice(0, 4)
            .map(t => `<span class="gs-result-tag"># ${highlightText(t, tokens)}</span>`)
            .join('');
          const snippetHtml =
            r.matchType !== 'title' && r.snippet
              ? `<div class="archive-hit-snippet">${highlightText(r.snippet, tokens)}</div>`
              : '';

          html +=
            `<a href="${escapeHtml(p.url)}" class="post archive-hit-post">` +
              `<h2 class="post-title">${highlightText(p.t, tokens)}</h2>` +
              `<div class="archive-hit-meta">` +
                `<span class="time" style="margin-top:0;">${escapeHtml(p.d)}</span>` +
                `<span class="gs-badge ${b.cls}">${b.text}</span>` +
                tagsHtml +
              `</div>` +
              snippetHtml +
            `</a>`;
        });
      });

      liveResultsEl.innerHTML = html;
    }

    function runArchiveSearch() {
      const q = inputEl.value || '';
      if (!q.trim()) {
        restoreStaticArchives();
        return;
      }

      staticListWrapper.style.display = 'none';
      if (paginationEl) paginationEl.style.display = 'none';
      liveResultsEl.style.display = 'block';

      executeSearch(q, archiveScope, state => {
        if (state.emptyQuery) {
          restoreStaticArchives();
          return;
        }
        const scopeDesc = archiveScope === 'title' ? '仅标题/标签' : '标题 + 全文';
        statusLeft.textContent = `在全站 ${totalPosts} 篇归档中找到 ${state.results.length} 篇匹配（${scopeDesc} · ${state.elapsedMs} ms）`;
        if (state.scanningBody) {
          statusRight.innerHTML =
            `<span class="gs-status-scanning"><span class="gs-spinner"></span>全文扫描 (${state.loadedChunks}/${state.totalChunks})</span>`;
        } else {
          statusRight.textContent = archiveScope === 'all' ? '已覆盖全站全文' : '仅匹配标题与标签';
        }
        renderArchiveResults(state.results, state.tokens);
      });
    }

    inputEl.addEventListener('focus', () => {
      ensureMetaLoaded().then(() => {
        if (searchWorker && archiveScope === 'all') {
          searchWorker.postMessage({ type: 'PREWARM_ALL' });
        }
      });
    });

    let composing = false;
    let timer = null;
    inputEl.addEventListener('compositionstart', () => {
      composing = true;
    });
    inputEl.addEventListener('compositionend', () => {
      composing = false;
      clearBtn.classList.toggle('is-visible', inputEl.value.length > 0);
      runArchiveSearch();
    });
    inputEl.addEventListener('input', () => {
      clearBtn.classList.toggle('is-visible', inputEl.value.length > 0);
      if (composing) return;
      clearTimeout(timer);
      timer = setTimeout(runArchiveSearch, 30);
    });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Escape' && inputEl.value) {
        e.preventDefault();
        e.stopPropagation();
        inputEl.value = '';
        clearBtn.classList.remove('is-visible');
        restoreStaticArchives();
      }
    });

    clearBtn.addEventListener('click', () => {
      inputEl.value = '';
      clearBtn.classList.remove('is-visible');
      inputEl.focus();
      restoreStaticArchives();
    });

    searchWrapper.querySelectorAll('.gs-scope-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        archiveScope = btn.getAttribute('data-scope') || 'all';
        searchWrapper.querySelectorAll('.gs-scope-btn').forEach(b => {
          b.classList.toggle('is-active', b === btn);
        });
        inputEl.placeholder =
          archiveScope === 'title'
            ? '在全站归档文章标题与标签中精准筛选...'
            : '在全站归档文章中实时搜索标题、标签或全文...';
        inputEl.focus();
        if (inputEl.value.trim()) runArchiveSearch();
      });
    });
  }

  /* ==========================================================================
     全局快捷键监听 (⌘K / Ctrl+K / 斜杠 /) 与初始化
     ========================================================================== */
  function bindGlobalShortcuts() {
    window.addEventListener('keydown', e => {
      // 如果图片放大灯箱开启，优先让灯箱处理 ESC
      const diagramZoomOpen = document.querySelector('.diagram-zoom-overlay.active');
      if (diagramZoomOpen) return;

      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
      if (isCmdK) {
        e.preventDefault();
        if (modalBackdrop && modalBackdrop.classList.contains('is-open')) {
          closeModal();
        } else {
          openModal();
        }
        return;
      }

      if (e.key === 'Escape' && modalBackdrop && modalBackdrop.classList.contains('is-open')) {
        e.preventDefault();
        closeModal();
        return;
      }

      // 非输入框聚焦状态下按 `/` 快捷唤出搜索（若在归档页则直接聚焦归档搜索框）
      const activeTag = document.activeElement ? document.activeElement.tagName : '';
      const isEditable =
        activeTag === 'INPUT' ||
        activeTag === 'TEXTAREA' ||
        (document.activeElement && document.activeElement.isContentEditable);

      if (!isEditable && !e.metaKey && !e.ctrlKey && !e.altKey && e.key === '/') {
        e.preventDefault();
        const archiveInput = document.querySelector('.archive-search-input');
        if (archiveInput && !(modalBackdrop && modalBackdrop.classList.contains('is-open'))) {
          archiveInput.focus();
        } else {
          openModal();
        }
      }
    });
  }

  function bootstrap() {
    mountHeaderButton();
    mountArchiveInlineSearch();
    bindGlobalShortcuts();

    // 首页或归档页在浏览器空闲时静默预加载 L1 热索引 (~175KB Gzip)，确保点击瞬间 0 等待
    const pathName = window.location.pathname || '/';
    if (pathName === '/' || pathName.indexOf('/page/') === 0 || pathName.indexOf('/archives') === 0) {
      const idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 1200); };
      idle(() => ensureMetaLoaded());
    }

    // 支持通过 URL 参数 ?q=xxx 直接打开搜索结果
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('q');
      if (q) {
        const archiveInput = document.querySelector('.archive-search-input');
        if (archiveInput) {
          archiveInput.value = q;
          archiveInput.dispatchEvent(new Event('input'));
        } else {
          openModal(q);
        }
      }
    } catch (e) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
