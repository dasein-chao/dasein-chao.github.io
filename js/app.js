/* app.js — 交互逻辑 */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var state = Store.load();
  var selectedSource = 'auto';
  var currentFilterTag = null;
  var previewConv = null;   // 预览中的对话（角色可能被用户改过）

  /* ---------- 工具 ---------- */
  function persist() { Store.save(state); refreshCounts(); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var toastTimer;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2200);
  }
  function setLinkStatus(cls, msg) {
    var el = $('#linkStatus');
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.className = 'link-status ' + cls;
    el.innerHTML = msg;
  }

  /* ---------- 从分享链接读取对话 ---------- */
  function doFetchLink() {
    var raw = $('#linkInput').value.trim();
    if (!raw) { toast('先粘贴一个分享链接'); return; }
    var btn = $('#fetchLinkBtn');
    btn.disabled = true; btn.textContent = '读取中…';
    setLinkStatus('loading', '正在读取分享链接，正在尝试通道…（可能需要几秒）');
    if (!window.LinkFetch) { setLinkStatus('err', '链接读取模块没加载成功，请刷新页面重试'); btn.disabled = false; btn.textContent = '读取链接'; return; }
    window.LinkFetch.fetchLink(raw, function (name) {
      setLinkStatus('loading', '正在读取… 当前通道：<b>' + esc(name) + '</b>（失败会自动换下一个）');
    }).then(function (res) {
      // 链接读到的文本同样过一遍统一清洗（去残留 markdown 噪音）
      var clean = Importers.sanitize(res.text);
      var isFull = /API/.test(res.via || '');
      var detail = isFull && res.count
        ? '完整对话 ' + res.count + ' 条（虚拟滚动看不见的也拿到了）'
        : clean.length + ' 字';
      // 能干净分出多段对话 → 直接建卡，一步到位（手机用户不用再点好几下）
      var conv = null;
      try { conv = Importers.parse('auto', clean); } catch (e2) { conv = null; }
      if (conv && conv.messages && conv.messages.length >= 2) {
        setLinkStatus('ok', '✅ 读到了对话（' + detail + '，通道：' + esc(res.via) + '），卡片已自动生成，去卡片库查看/润色。');
        goto('cards');
        setTimeout(function () {
          var n = autoBuildFromConv(conv);
          toast('已自动生成 ' + n + ' 张草稿卡片，去卡片库润色');
        }, 60);
        return;
      }
      // 分不出多段 → 填进框让用户核对角色
      $('#rawInput').value = clean;
      previewConv = null; $('#previewPanel').classList.add('hidden');
      updateAutoDetect();
      setLinkStatus('ok', '✅ 读到了内容（' + detail + '，通道：' + esc(res.via) + '），已填进下面的框，点「看识别预览」检查角色对不对。');
      toast('读取成功，已填入下方');
    }).catch(function (e) {
      var orig = $('#linkInput').value.trim();
      var fallback = orig ? ('<br>手动兜底：自己打开 <a href="https://r.jina.ai/' + esc(orig) + '" target="_blank" rel="noopener">这个阅读版网址</a>，全选复制文字，贴到下面的框里。') : '';
      setLinkStatus('err', '❌ ' + esc(e.message || '读取失败') + fallback);
      toast('读取失败，详见提示');
    }).finally(function () {
      btn.disabled = false; btn.textContent = '读取链接';
    });
  }
  // 从标准对话对象一步到位生成卡片并入库、弹结果（自动导入路径共用）
  function autoBuildFromConv(conv) {
    if (!conv || !conv.messages || !conv.messages.length) { toast('对话里没有可生成的消息'); return 0; }
    var made = Analyzer.analyzeLocal(conv);
    var n = 0;
    Store.update(function (st) {
      st.conversations.unshift(conv);
      st.cards = made.concat(st.cards);
      n = made.length;
    });
    state = Store.load(); persist(); renderCards();
    showImportResult(1, n, 1);
    return n;
  }

  /* ---------- 导入油猴脚本导出的 JSON 文件 ---------- */
  function handleExportedFile(data) {
    if (data.format === 'conversation-bundle') {
      var convs = (data.conversations || []).filter(function (c) {
        return c && Array.isArray(c.messages) && c.messages.length;
      });
      if (!convs.length) { toast('文件里没有可导入的对话'); return; }
      var ok = 0, cards = 0;
      Store.update(function (d) {
        convs.forEach(function (c) {
          var conv = Importers.parse('dsjson', c);
          if (conv.messages.length) {
            d.conversations.unshift(conv);
            var made = Analyzer.analyzeLocal(conv);
            d.cards = made.concat(d.cards);
            cards += made.length; ok++;
          }
        });
      });
      state = Store.load(); persist();
      toast('导入 ' + ok + ' 个对话，生成 ' + cards + ' 张卡片');
      showImportResult(ok, cards, convs.length);
    } else {
      // 单对话：填入输入框 + 直接生成预览
      var conv = Importers.parse('dsjson', data);
      if (!conv.messages.length) { toast('文件里没有可导入的对话'); return; }
      $('#rawInput').value = conv.messages.map(function (m) {
        return (m.role === 'assistant' ? '助手：' : '用户：') + m.content;
      }).join('\n\n');
      updateAutoDetect();
      previewConv = conv;
      $('#previewPanel').classList.remove('hidden');
      renderPreview();
      toast('已载入 ' + conv.messages.length + ' 条消息，检查角色后点「生成卡片」');
      $('#previewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ---------- DeepSeek 一键导出器：安装检测 + 自动回传 ---------- */
  var DS_MAGIC = '__dasein_export_v1__';
  var DS_TOKEN_KEY = 'dasein_ds_token';

  // 油猴商店按浏览器给正确地址；移动端给出提示
  function dsStoreInfo() {
    var ua = navigator.userAgent;
    var mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    var url, name;
    if (/Edg\//.test(ua)) { url = 'https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd'; name = 'Edge'; }
    else if (/Firefox\//i.test(ua)) { url = 'https://addons.mozilla.org/zh-CN/firefox/addon/tampermonkey/'; name = 'Firefox'; }
    else if (/Chrome\//.test(ua)) { url = 'https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo'; name = 'Chrome'; }
    else { url = 'https://www.tampermonkey.net/'; name = '你的浏览器'; }
    return { url: url, name: name, mobile: mobile };
  }

  // 检测导出脚本是否已装（脚本在产品页会打标记 + 派发事件）
  function checkDsInstalled() {
    var installed = !!(window.__daseinDsExport && window.__daseinDsExport.installed) ||
      document.documentElement.hasAttribute('data-ds-export-installed');
    var badge = $('#dsStepStatus');
    var goBtn = $('#dsGoBtn');
    var hint = $('#dsGoHint');
    if (!badge) return installed;
    if (installed) {
      badge.innerHTML = '<span class="ds-ok">✓ 已安装导出器，可以直接用</span>';
      badge.classList.remove('hidden');
      if (goBtn) { goBtn.classList.remove('hidden', 'disabled'); goBtn.textContent = '🚀 去 DeepSeek 导出，自动送回这里'; }
      if (hint) hint.textContent = '点下面的按钮打开 DeepSeek，导出后数据会自动回到这个页面。';
    } else {
      // 关键：不拦按钮、不说死「没装」。沙箱/缓存都可能让检测失效，
      // 让用户直接点去试——DS 页脚本运行了就能导出，这是最可靠的判断。
      badge.innerHTML = '<span class="ds-wait">没检测到也不用纠结，直接点下面按钮试一次；若装好了就能导出，没装再按 ①② 步装。</span>';
      badge.classList.remove('hidden');
      if (goBtn) { goBtn.classList.remove('hidden', 'disabled'); goBtn.textContent = '🚀 去 DeepSeek 导出，自动送回这里'; }
    }
    return installed;
  }

  // 一键跳转：生成一次性令牌，带在 DS 网址上；导出脚本会凭它把数据送回。
  // 注意：绝不因为「检测不到」而拦截——检测沙箱等环境会误报，而脚本在 DS 页一定运行，
  // 让用户直接点、能导出就说明装好了，才是真正不添堵的做法。
  function goDsExport() {
    var info = dsStoreInfo();
    if (info.mobile) { toast('手机请用「分享链接」方式导入'); selectWay('link'); return; }
    var token = 'tk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    try { sessionStorage.setItem(DS_TOKEN_KEY, token); } catch (e) {}
    var from = location.href.split('#')[0];
    var target = 'https://chat.deepseek.com/?dasein_from=' + encodeURIComponent(from) +
      '&dasein_token=' + encodeURIComponent(token) + '&dasein_t=' + Date.now();
    window.open(target, '_blank', 'noopener');
    setLinkStatus('loading', '已打开 DeepSeek。<b>在页面右下角点「🚀 导出并自动返回」</b>，稍等几秒，对话会自动回到这里并生成卡片——不用复制、不用切回来。');
    $('#linkPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('已打开 DeepSeek，点右下角的导出按钮即可');
  }

  // 接收导出脚本 postMessage 回来的数据（magic + 一次性令牌双重校验）
  function listenDsExport() {
    window.addEventListener('message', function (e) {
      var d = e.data;
      if (!d || d.magic !== DS_MAGIC || !d.data) return;
      // 令牌校验：必须是本标签页刚发出的令牌，且只用一次
      var expect = null;
      try { expect = sessionStorage.getItem(DS_TOKEN_KEY); } catch (err) {}
      if (!expect || d.token !== expect) {
        setLinkStatus('err', '收到导出数据，但令牌对不上（可能是上一次的旧窗口）。请回到本页重新点「去 DeepSeek 导出」，再在 DeepSeek 点导出。');
        return;
      }
      try { sessionStorage.removeItem(DS_TOKEN_KEY); } catch (err) {}
      // 自动回传=用户已在 DS 点过一次，这里直接一步到位生成卡片，不再要求二次点击
      setLinkStatus('ok', '✅ 已收到 DeepSeek 导出的完整对话，卡片已生成，去卡片库查看/润色。');
      goto('cards');
      setTimeout(function () {
        try {
          var payload = d.data;
          if (payload.format === 'conversation-bundle') {
            handleExportedFile(payload); // 全量包：内部直接入库 + 弹结果
            return;
          }
          // 单对话：直接解析→生成卡片→入库→弹结果，跳过预览
          var conv = Importers.parse('dsjson', payload);
          var okN = autoBuildFromConv(conv);
          toast('已自动生成 ' + okN + ' 张草稿卡片，去卡片库润色');
        } catch (err) {
          setLinkStatus('err', '数据收到了，但生成卡片时出错：' + esc(err.message || String(err)));
        }
      }, 60);
    });
    // 脚本晚于页面加载注入时用事件再检测一次
    window.addEventListener('dasein-ds-installed', checkDsInstalled);
  }

  function showImportResult(ok, cards, total) {
    $('#resultModalBody').innerHTML =
      '<p style="margin-bottom:14px;color:#5b6270">从 DeepSeek 导出文件导入了 <b style="color:#10a37f">' + ok + '</b> / ' + total + ' 个对话，' +
      '本地规则生成了 <b style="color:#10a37f">' + cards + '</b> 张卡片。</p>' +
      '<p class="hint">几万个字、几百轮的对话一次性就导完了——这就是虚拟滚动看不见的部分。建议去卡片库把草稿改成你自己的话。</p>';
    openModal('resultModal');
  }

  function goto(view) {
    $$('.nav-item').forEach(function (n) { n.classList.toggle('active', n.dataset.view === view); });
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    $('.main').scrollTop = 0;
    if (view === 'cards') renderCards();
    if (view === 'review') refreshReviewSetup();
  }

  function refreshCounts() {
    $('#cardCount').textContent = state.cards.length;
    $('#statTotal').textContent = state.cards.length;
    $('#statMastered').textContent = state.cards.filter(function (c) { return c.mastery >= 4; }).length;
  }

  /* ---------- 来源选择 ---------- */
  // 来源格式全自动识别，不再让用户选（旧版那 6 个选项点了大多没反应，已移除）
  function renderSources() { /* 保留空函数，兼容旧调用 */ }

  // 方式切换：paste / link / ds / manual —— 只显示对应的输入框
  function selectWay(way) {
    $$('#wayGrid .way-card').forEach(function (b) { b.classList.toggle('selected', b.dataset.way === way); });
    var show = {
      paste: ['#pastePanel'],
      link: ['#linkPanel'],
      ds: ['#dsPanel'],
      manual: ['#manualPanel']
    };
    ['#pastePanel', '#linkPanel', '#dsPanel', '#manualPanel'].forEach(function (sel) {
      var el = $(sel); if (el) el.classList.add('hidden');
    });
    (show[way] || show.paste).forEach(function (sel) { var el = $(sel); if (el) el.classList.remove('hidden'); });
    // 方式切换时保留解析来源=auto（全自动识别）
    selectedSource = way === 'manual' ? 'manual' : 'auto';
    $('#autoTag').textContent = '';
    if (way === 'ds') { checkDsInstalled(); updateDsMobileUI(); }
  }

  // 手机装不了油猴：DS 面板对手机用户显示「用分享链接」引导，隐藏三步向导
  function updateDsMobileUI() {
    var mobile = dsStoreInfo().mobile;
    var wizard = $('#dsWizard');
    var mnote = $('#dsMobileNote');
    if (wizard) wizard.classList.toggle('hidden', mobile);
    if (mnote) mnote.classList.toggle('hidden', !mobile);
  }

  /* ---------- 自动识别提示 ---------- */
  function updateAutoDetect() {
    if (selectedSource !== 'auto') { $('#autoTag').textContent = ''; return; }
    var raw = Importers.sanitize($('#rawInput').value.trim());
    if (raw.length < 10) { $('#autoTag').textContent = ''; return; }
    var guess = Importers.autoDetect(raw);
    var a = Importers.get(guess);
    $('#autoTag').textContent = '识别为：' + (a ? a.name : '通用');
  }

  /* ---------- 识别预览 ---------- */
  function buildPreviewConv() {
    if (selectedSource === 'manual') {
      return Importers.parse('manual', {
        title: $('#manualTitle').value.trim(),
        question: $('#manualQuestion').value,
        answer: $('#manualAnswer').value
      });
    }
    // ★ 统一清洗：粘贴/文件导入的文本先去掉 markdown 噪音，再解析
    var raw = Importers.sanitize($('#rawInput').value.trim());
    if (!raw) { toast('先粘贴对话内容'); return null; }
    var src = selectedSource === 'auto' ? Importers.autoDetect(raw) : selectedSource;
    try {
      return Importers.parse(src, raw);
    } catch (e) {
      toast('解析失败：' + e.message); return null;
    }
  }

  function highlight(text, kw) {
    var safe = esc(text);
    if (!kw) return safe;
    var escapedKw = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return safe.replace(new RegExp(escapedKw, 'gi'), function (m) { return '<mark>' + m + '</mark>'; }); }
    catch (e) { return safe; }
  }

  function renderPreview() {
    var kw = ($('#previewKeyword').value || '').trim();
    var onlyMatch = $('#onlyMatch').checked;
    var msgs = previewConv.messages;
    var list = $('#previewList');
    list.innerHTML = '';
    var matched = 0;

    msgs.forEach(function (m, i) {
      var hit = kw && m.content.toLowerCase().indexOf(kw.toLowerCase()) >= 0;
      if (hit) matched++;
      if (onlyMatch && kw && !hit) return;
      var row = document.createElement('div');
      row.className = 'pmsg' + (hit ? ' match-hit' : '');
      var roleCls = m.role === 'assistant' ? 'assistant' : 'user';
      var roleTxt = m.role === 'assistant' ? 'AI 答' : '用户';
      row.innerHTML =
        '<span class="pmsg-idx">' + (i + 1) + '</span>' +
        '<span class="pmsg-role ' + roleCls + '" data-msg-idx="' + i + '" title="点一下切换角色">' + roleTxt + '</span>' +
        '<div class="pmsg-body">' + (m.content ? highlight(m.content, kw) : '<span style="color:#b8bdc9">（空）</span>') + '</div>';
      list.appendChild(row);
    });

    if (!list.children.length) {
      list.innerHTML = '<div class="preview-empty">' + (kw ? '没有含「' + esc(kw) + '」的对话' : '没有内容') + '</div>';
    }
    $('#previewCount').textContent = msgs.length + ' 段';
    // 绑定角色切换
    $$('.pmsg-role', list).forEach(function (el) {
      el.addEventListener('click', function () {
        var idx = parseInt(el.dataset.msgIdx, 10);
        var m = previewConv.messages[idx];
        m.role = m.role === 'assistant' ? 'user' : 'assistant';
        renderPreview();
      });
    });
  }

  function doPreview() {
    var conv = buildPreviewConv();
    if (!conv || !conv.messages.length) { toast('没识别到对话内容，检查一下粘贴的文字'); return; }
    previewConv = conv;
    $('#previewPanel').classList.remove('hidden');
    $('#previewCount').textContent = conv.messages.length + ' 段';
    renderPreview();
    $('#previewPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- 生成卡片 ---------- */
  function doParse() {
    // 优先用预览中（可能被改过角色）的对话；没预览就现解析
    var conv = previewConv || buildPreviewConv();
    if (!conv) return;
    if (!conv.messages.length) { toast('没识别到对话内容，检查一下格式吧'); return; }

    var useAI = $('#useAI').checked;
    if (useAI && !state.settings.apiKey) {
      toast('没填 API Key，已改用本地分析（可在设置里填 key）');
      useAI = false;
    }

    var run = useAI
      ? Analyzer.aiAnalyze(conv, state.settings)
      : Promise.resolve(Analyzer.analyzeLocal(conv));

    $('#parseBtn').disabled = true;
    $('#parseBtn').textContent = useAI ? 'AI 归纳中…' : '生成中…';

    run.then(function (cards) {
      if (!cards || !cards.length) { toast('没能提炼出卡片，试试手动两段模式'); return; }
      Store.update(function (d) { d.cards = cards.concat(d.cards); d.conversations.unshift(conv); });
      state = Store.load();
      persist();
      showResult(cards, conv);
    }).catch(function (err) {
      toast('AI 归纳失败：' + err.message + '。已用本地分析重试。');
      var cards = Analyzer.analyzeLocal(conv);
      Store.update(function (d) { d.cards = cards.concat(d.cards); d.conversations.unshift(conv); });
      state = Store.load(); persist();
      showResult(cards, conv);
    }).finally(function () {
      $('#parseBtn').disabled = false;
      $('#parseBtn').textContent = '生成卡片 →';
      previewConv = null;
      $('#previewPanel').classList.add('hidden');
      $('#rawInput').value = '';
      $('#autoTag').textContent = '';
      updateAutoDetect();
    });
  }

  function showResult(cards, conv) {
    var list = cards.slice(0, 8).map(function (c, i) {
      return '<li><span class="result-num">' + (i + 1) + '</span><span><b>' + esc(c.title) + '</b><br>' +
        '<span style="color:#8a90a0">' + esc((c.insight || c.confusion || '').slice(0, 70)) + '…</span></span></li>';
    }).join('');
    $('#resultModalBody').innerHTML =
      '<p style="margin-bottom:14px;color:#5b6270">从「' + esc(conv.title) + '」生成了 <b style="color:#10a37f">' + cards.length + '</b> 张卡片：' +
      (cards.length > 8 ? '（显示前 8 张）' : '') + '</p>' +
      '<ul class="result-list">' + list + '</ul>' +
      '<p class="hint" style="margin-top:14px">建议去卡片库逐张润色——AI/规则只是草稿，用自己的话改过才记得住。</p>';
    openModal('resultModal');
  }

  /* ---------- 卡片库 ---------- */
  function getVisibleCards() {
    var q = ($('#searchInput').value || '').trim().toLowerCase();
    var sort = $('#sortSelect').value;
    var cards = state.cards.filter(function (c) {
      if (currentFilterTag && (c.keywords || []).indexOf(currentFilterTag) < 0) return false;
      if (!q) return true;
      var hay = [c.title, c.confusion, c.insight, c.mnemonic, (c.keywords || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    cards.sort(function (a, b) {
      if (sort === 'weak') return (a.mastery - b.mastery) || (b.createdAt.localeCompare(a.createdAt));
      if (sort === 'reviewed') return (b.lastReview || '').localeCompare(a.lastReview || '');
      if (sort === 'starred') return (b.starred ? 1 : 0) - (a.starred ? 1 : 0) || b.createdAt.localeCompare(a.createdAt);
      return b.createdAt.localeCompare(a.createdAt);
    });
    return cards;
  }

  function renderCards() {
    var cards = getVisibleCards();
    var grid = $('#cardGrid');
    grid.innerHTML = '';
    $('#cardsEmpty').classList.toggle('hidden', cards.length > 0);

    cards.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'kcard';
      var dots = '';
      for (var i = 0; i < 5; i++) dots += '<span class="mdot' + (i < c.mastery ? ' on' : '') + '"></span>';
      var tags = (c.keywords || []).slice(0, 4).map(function (t) { return '<span class="ktag">' + esc(t) + '</span>'; }).join('');
      el.innerHTML =
        '<div class="kcard-top"><div class="kcard-title">' + esc(c.title) + '</div>' +
        '<span class="kcard-star' + (c.starred ? ' on' : '') + '" data-star="' + c.id + '">' + (c.starred ? '★' : '☆') + '</span></div>' +
        '<div class="kcard-insight">' + esc(c.insight || c.confusion || '（还没写内容）') + '</div>' +
        '<div class="kcard-tags">' + tags + '</div>' +
        '<div class="kcard-foot"><span class="mastery-dots">' + dots + '</span>' +
        '<span><span class="mode-tag ' + (c.mode || 'local') + '">' + (c.mode === 'ai' ? 'AI' : '本地') + '</span> · ' + esc(fmtDate(c.createdAt)) + '</span></div>';
      el.addEventListener('click', function (e) {
        if (e.target.dataset.star) { toggleStar(c.id); return; }
        openEdit(c.id);
      });
      grid.appendChild(el);
    });

    renderTagFilter();
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  function renderTagFilter() {
    var all = {};
    state.cards.forEach(function (c) { (c.keywords || []).forEach(function (k) { all[k] = (all[k] || 0) + 1; }); });
    var tags = Object.keys(all).sort(function (a, b) { return all[b] - all[a]; }).slice(0, 12);
    var box = $('#tagFilter');
    box.innerHTML = '';
    if (!tags.length) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    var allChip = document.createElement('span');
    allChip.className = 'tag-chip' + (!currentFilterTag ? ' active' : '');
    allChip.textContent = '全部';
    allChip.addEventListener('click', function () { currentFilterTag = null; renderCards(); });
    box.appendChild(allChip);
    tags.forEach(function (t) {
      var chip = document.createElement('span');
      chip.className = 'tag-chip' + (currentFilterTag === t ? ' active' : '');
      chip.textContent = t + ' ' + all[t];
      chip.addEventListener('click', function () { currentFilterTag = currentFilterTag === t ? null : t; renderCards(); });
      box.appendChild(chip);
    });
  }

  function toggleStar(id) {
    Store.update(function (d) {
      var c = d.cards.find(function (x) { return x.id === id; });
      if (c) c.starred = !c.starred;
    });
    state = Store.load(); persist(); renderCards();
  }

  /* ---------- 编辑弹窗 ---------- */
  var editingId = null;
  function openEdit(id) {
    var c = state.cards.find(function (x) { return x.id === id; });
    if (!c) return;
    editingId = id;
    var qs = (c.questions || []).map(function (q, i) {
      return qRow(q.q, q.a, q.type, i);
    }).join('');
    $('#editBody').innerHTML =
      '<div class="edit-field"><label>标题</label><input class="input" data-f="title" value="' + esc(c.title) + '"></div>' +
      '<div class="edit-field"><label>我卡在哪 / 错误理解</label><textarea class="input textarea" data-f="confusion" rows="3">' + esc(c.confusion) + '</textarea></div>' +
      '<div class="edit-field"><label>正确理解（核心）</label><textarea class="input textarea" data-f="insight" rows="4">' + esc(c.insight) + '</textarea></div>' +
      '<div class="edit-field"><label>助记 / 口诀 / 类比</label><textarea class="input textarea" data-f="mnemonic" rows="2">' + esc(c.mnemonic) + '</textarea></div>' +
      '<div class="edit-field"><label>什么时候会用到（触发场景）</label><input class="input" data-f="scene" value="' + esc(c.scene) + '"></div>' +
      '<div class="edit-field"><label>关键词（用 / 分隔）</label><input class="input" data-f="keywords" value="' + esc((c.keywords || []).join(' / ')) + '"></div>' +
      '<div class="edit-field"><label>自测题</label><div id="qList">' + qs + '</div>' +
      '<button class="btn ghost tiny" id="addQBtn">+ 加一题</button></div>';
    $('#addQBtn').addEventListener('click', function () {
      $('#qList').insertAdjacentHTML('beforeend', qRow('', '', '简答', Date.now()));
    });
    openModal('editModal');
  }

  function qRow(q, a, type, i) {
    return '<div class="q-edit-row" data-q="' + i + '">' +
      '<input class="input" data-qf="q" placeholder="题目" value="' + esc(q) + '">' +
      '<input class="input" data-qf="a" placeholder="答案" value="' + esc(a) + '">' +
      '<button class="btn ghost tiny q-del">✕</button></div>';
  }

  function saveEdit() {
    if (!editingId) return;
    Store.update(function (d) {
      var c = d.cards.find(function (x) { return x.id === editingId; });
      if (!c) return;
      ['title', 'confusion', 'insight', 'mnemonic', 'scene'].forEach(function (f) {
        var el = $('[data-f="' + f + '"]', $('#editBody'));
        if (el) c[f] = el.value.trim();
      });
      var kwEl = $('[data-f="keywords"]', $('#editBody'));
      if (kwEl) c.keywords = kwEl.value.split(/[\/，,]/).map(function (s) { return s.trim(); }).filter(Boolean);
      c.questions = $$('.q-edit-row', $('#editBody')).map(function (row) {
        return {
          q: $('[data-qf="q"]', row).value.trim(),
          a: $('[data-qf="a"]', row).value.trim(),
          type: '简答'
        };
      }).filter(function (x) { return x.q; });
      c.edited = true;
    });
    state = Store.load(); persist();
    closeModal('editModal');
    toast('已保存');
    renderCards();
  }

  function deleteCard() {
    if (!editingId) return;
    if (!confirm('确定删除这张卡片？')) return;
    Store.update(function (d) { d.cards = d.cards.filter(function (x) { return x.id !== editingId; }); });
    state = Store.load(); persist();
    closeModal('editModal'); renderCards(); toast('已删除');
  }

  function addBlankCard() {
    var c = {
      id: 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
      sourceTitle: '手动新建', source: 'manual', createdAt: new Date().toISOString(),
      title: '新卡片', confusion: '', insight: '', mnemonic: '', scene: '', keywords: [],
      questions: [], confidence: 5, reviewCount: 0, lastReview: null, mastery: 0,
      starred: false, edited: true, mode: 'local'
    };
    Store.update(function (d) { d.cards.unshift(c); });
    state = Store.load(); persist(); renderCards(); openEdit(c.id);
  }

  /* ---------- 复习 ---------- */
  var reviewQueue = [], reviewIdx = 0, reviewFlipped = false;
  var quizQueue = [], quizIdx = 0, quizFlipped = false;

  function refreshReviewSetup() {
    var due = state.cards.filter(function (c) { return c.mastery < 4; });
    var withQ = state.cards.filter(function (c) { return (c.questions || []).length; });
    $('#dueCount').textContent = due.length;
    $('#quizCount').textContent = withQ.reduce(function (n, c) { return n + c.questions.length; }, 0);
    $('#reviewEmpty').classList.toggle('hidden', state.cards.length > 0);
    $('#reviewSetup').classList.toggle('hidden', state.cards.length === 0);
  }

  function startReview() {
    var due = state.cards.filter(function (c) { return c.mastery < 4; });
    var pool = due.length ? due : state.cards;
    if (!pool.length) { toast('还没有卡片'); return; }
    reviewQueue = shuffle(pool.slice()); reviewIdx = 0;
    $('#reviewSetup').classList.add('hidden');
    $('#reviewSession').classList.remove('hidden');
    showReviewCard();
  }
  function showReviewCard() {
    if (reviewIdx >= reviewQueue.length) {
      $('#reviewSession').classList.add('hidden');
      $('#reviewSetup').classList.remove('hidden');
      refreshReviewSetup(); toast('这一轮复习完成 🎉'); return;
    }
    var c = reviewQueue[reviewIdx];
    reviewFlipped = false;
    $('#fcTitle').textContent = c.title;
    $('#fcScene').textContent = c.confusion || c.scene || '（这张卡还没写卡点，点开卡片补一下会记得更好）';
    $('#flashcardBack').classList.add('hidden');
    $('#flashcardFront').classList.remove('hidden');
    $('#flashcard').classList.remove('hidden');
    $('#flipBtn').classList.remove('hidden');
    $('#gradeRow').classList.add('hidden');
    $('#reviewProgressText').textContent = (reviewIdx + 1) + ' / ' + reviewQueue.length;
    $('#progressFill').style.width = ((reviewIdx) / reviewQueue.length * 100) + '%';
  }
  function flipCard() {
    var c = reviewQueue[reviewIdx];
    $('#fcInsight').textContent = c.insight || '（还没有正确理解，去卡片库补一下）';
    $('#fcMnemonic').textContent = c.mnemonic || '';
    $('#fcMnemonic').classList.toggle('hidden', !c.mnemonic);
    $('#flashcardFront').classList.add('hidden');
    $('#flashcardBack').classList.remove('hidden');
    $('#flipBtn').classList.add('hidden');
    $('#gradeRow').classList.remove('hidden');
    reviewFlipped = true;
  }
  function gradeReview(g) {
    var c = reviewQueue[reviewIdx];
    var newMastery = g === 0 ? 0 : (g === 2 ? Math.max(1, c.mastery) : Math.min(5, c.mastery + 2));
    Store.update(function (d) {
      var x = d.cards.find(function (y) { return y.id === c.id; });
      if (x) { x.mastery = newMastery; x.reviewCount++; x.lastReview = new Date().toISOString(); }
    });
    state = Store.load(); persist();
    if (g === 0) reviewQueue.push(c); // 忘了的放到队尾再来一次
    reviewIdx++;
    showReviewCard();
  }

  function startQuiz() {
    quizQueue = [];
    state.cards.forEach(function (c) {
      (c.questions || []).forEach(function (q) { quizQueue.push({ card: c, q: q }); });
    });
    if (!quizQueue.length) { toast('还没有题目，去卡片库加几道吧'); return; }
    quizQueue = shuffle(quizQueue); quizIdx = 0;
    $('#reviewSetup').classList.add('hidden');
    $('#quizSession').classList.remove('hidden');
    showQuiz();
  }
  function showQuiz() {
    if (quizIdx >= quizQueue.length) {
      $('#quizSession').classList.add('hidden');
      $('#reviewSetup').classList.remove('hidden');
      refreshReviewSetup(); toast('自测完成 🎉'); return;
    }
    var item = quizQueue[quizIdx];
    quizFlipped = false;
    $('#quizType').textContent = item.q.type || '简答';
    $('#quizQ').textContent = item.q.q;
    $('#quizA').textContent = item.q.a || '（这道题没写答案）';
    $('#quizA').classList.add('hidden');
    $('#showAnswerBtn').classList.remove('hidden');
    $('#quizGradeRow').classList.add('hidden');
    $('#quizProgressText').textContent = (quizIdx + 1) + ' / ' + quizQueue.length;
    $('#quizProgressFill').style.width = (quizIdx / quizQueue.length * 100) + '%';
  }
  function gradeQuiz(g) {
    var item = quizQueue[quizIdx];
    Store.update(function (d) {
      var c = d.cards.find(function (y) { return y.id === item.card.id; });
      if (c) {
        c.reviewCount++; c.lastReview = new Date().toISOString();
        c.mastery = g === 0 ? 0 : Math.min(5, c.mastery + 1);
      }
    });
    state = Store.load(); persist();
    quizIdx++; showQuiz();
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  /* ---------- 设置 ---------- */
  function loadSettingsUI() {
    var s = state.settings;
    $('#presetSelect').value = s.preset || 'deepseek';
    $('#baseUrlInput').value = s.baseUrl || '';
    $('#modelInput').value = s.model || '';
    $('#apiKeyInput').value = s.apiKey || '';
  }
  function saveSettings() {
    Store.update(function (d) {
      d.settings.preset = $('#presetSelect').value;
      d.settings.baseUrl = $('#baseUrlInput').value.trim();
      d.settings.model = $('#modelInput').value.trim();
      d.settings.apiKey = $('#apiKeyInput').value.trim();
    });
    state = Store.load(); persist();
    $('#settingsTip').textContent = '✓ 已保存';
    setTimeout(function () { $('#settingsTip').textContent = ''; }, 2000);
  }

  /* ---------- 弹窗 ---------- */
  function openModal(id) { $('#' + id).classList.remove('hidden'); }
  function closeModal(id) { $('#' + id).classList.add('hidden'); }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $$('.nav-item').forEach(function (n) { n.addEventListener('click', function () { goto(n.dataset.view); }); });
    $$('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { goto(b.dataset.goto); }); });
    $$('[data-close]').forEach(function (b) { b.addEventListener('click', function () { closeModal(b.dataset.close); }); });

    // 教程折叠
    $('#guideHead').addEventListener('click', function () {
      var body = $('#guideBody');
      body.classList.toggle('hidden');
      $('#guideToggle').textContent = body.classList.contains('hidden') ? '展开 ▾' : '收起 ▴';
    });

    $('#parseBtn').addEventListener('click', doParse);
    $('#previewBtn').addEventListener('click', doPreview);
    $('#regenPreviewBtn').addEventListener('click', doPreview);
    $('#previewKeyword').addEventListener('input', renderPreview);
    $('#onlyMatch').addEventListener('change', renderPreview);
    $('#clearInputBtn').addEventListener('click', function () {
      $('#rawInput').value = ''; $('#manualQuestion').value = ''; $('#manualAnswer').value = ''; $('#autoTag').textContent = '';
      previewConv = null; $('#previewPanel').classList.add('hidden'); updateAutoDetect();
    });
    $('#rawInput').addEventListener('input', function () {
      updateAutoDetect();
      // 贴了新内容就作废旧预览
      if (previewConv) { previewConv = null; $('#previewPanel').classList.add('hidden'); }
    });

    // 手动整理格式：把 textarea 里的噪音文本原地清洗成干净对话
    $('#tidyBtnWrap').addEventListener('click', function () {
      var before = $('#rawInput').value;
      if (!before.trim()) { toast('先粘贴对话内容'); return; }
      var after = Importers.sanitize(before);
      if (!after.trim()) {
        toast('这段里只有联网搜索外壳、没有对话正文——请在原对话里全选复制文字再贴进来');
        return;
      }
      if (after === before.trim()) { toast('格式已经很干净了，不用整理'); return; }
      $('#rawInput').value = after; updateAutoDetect();
      previewConv = null; $('#previewPanel').classList.add('hidden');
      toast('已整理：去掉网址/#号等噪音（' + before.length + ' → ' + after.length + ' 字）');
    });

    // 链接读取
    $('#fetchLinkBtn').addEventListener('click', doFetchLink);
    $('#linkInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doFetchLink(); });

    // 导入方式切换（选哪个显示哪个输入框）
    $$('#wayGrid .way-card').forEach(function (b) {
      b.addEventListener('click', function () { selectWay(b.dataset.way); });
    });
    if ($('#dsToLinkBtn')) $('#dsToLinkBtn').addEventListener('click', function () { selectWay('link'); });

    // DeepSeek 一键导出器向导
    if ($('#dsGoBtn')) {
      $('#dsGoBtn').addEventListener('click', goDsExport);
      var store = dsStoreInfo();
      if ($('#dsStoreLink')) {
        $('#dsStoreLink').href = store.url;
        $('#dsStoreName').textContent = store.name;
      }
      updateDsMobileUI();
    }

    $('#fileInput').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        var text = String(r.result || '');
        var trimmed = text.trim();
        // 检测是不是「顿悟卡片导出器」生成的 JSON（单对话 / 全量包）
        var data = null;
        if (trimmed && (trimmed[0] === '{' || trimmed[0] === '[')) {
          try { data = JSON.parse(trimmed); } catch (e2) { data = null; }
        }
        if (data && data.app === 'insight-cards' && (data.format === 'conversation' || data.format === 'conversation-bundle')) {
          handleExportedFile(data);
          e.target.value = '';
          return;
        }
        // 普通文本文件：走原来的清洗路径
        $('#rawInput').value = Importers.sanitize(text); updateAutoDetect();
        previewConv = null; $('#previewPanel').classList.add('hidden');
        toast('文件已载入并整理格式，点「看识别预览」检查');
      };
      r.readAsText(f);
    });

    $('#presetSelect').addEventListener('change', function () {
      var p = Analyzer.PRESETS[$('#presetSelect').value];
      if (p) { $('#baseUrlInput').value = p.baseUrl; $('#modelInput').value = p.model; }
    });
    $('#saveSettingsBtn').addEventListener('click', saveSettings);

    $('#searchInput').addEventListener('input', renderCards);
    $('#sortSelect').addEventListener('change', renderCards);
    $('#addCardBtn').addEventListener('click', addBlankCard);
    $('#saveCardBtn').addEventListener('click', saveEdit);
    $('#deleteCardBtn').addEventListener('click', deleteCard);
    $('#editBody').addEventListener('click', function (e) {
      if (e.target.classList.contains('q-del')) e.target.closest('.q-edit-row').remove();
    });
    $('#goCardsBtn').addEventListener('click', function () { closeModal('resultModal'); goto('cards'); });

    // 复习
    $('#startReviewBtn').addEventListener('click', startReview);
    $('#flipBtn').addEventListener('click', flipCard);
    $('#flashcard').addEventListener('click', function () { if (!reviewFlipped) flipCard(); });
    $$('#gradeRow .grade').forEach(function (b) { b.addEventListener('click', function () { gradeReview(parseInt(b.dataset.grade, 10)); }); });
    $('#exitReviewBtn').addEventListener('click', function () {
      $('#reviewSession').classList.add('hidden'); $('#reviewSetup').classList.remove('hidden'); refreshReviewSetup();
    });
    $('#startQuizBtn').addEventListener('click', startQuiz);
    $('#showAnswerBtn').addEventListener('click', function () {
      $('#quizA').classList.remove('hidden'); $('#showAnswerBtn').classList.add('hidden'); $('#quizGradeRow').classList.remove('hidden');
    });
    $$('#quizGradeRow .grade').forEach(function (b) { b.addEventListener('click', function () { gradeQuiz(parseInt(b.dataset.grade, 10)); }); });
    $('#exitQuizBtn').addEventListener('click', function () {
      $('#quizSession').classList.add('hidden'); $('#reviewSetup').classList.remove('hidden'); refreshReviewSetup();
    });

    // 数据管理
    $('#exportBtn').addEventListener('click', function () {
      var blob = new Blob([Store.exportBackup()], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '顿悟卡片备份_' + new Date().toISOString().slice(0, 10) + '.json';
      a.click(); URL.revokeObjectURL(a.href);
      toast('备份已导出');
    });
    $('#importBackupInput').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          Store.importBackup(r.result);
          state = Store.load(); persist(); loadSettingsUI(); renderCards();
          toast('备份已导入');
        } catch (err) { toast('导入失败：' + err.message); }
      };
      r.readAsText(f);
    });
    $('#clearAllBtn').addEventListener('click', function () {
      if (!confirm('确定清空所有卡片和设置？此操作不可恢复，建议先导出备份。')) return;
      localStorage.removeItem(Store.KEY);
      state = Store.load(); persist(); loadSettingsUI(); renderCards();
      toast('已清空');
    });

    // 快捷键
    document.addEventListener('keydown', function (e) {
      if (!$('#reviewSession').classList.contains('hidden')) {
        if (e.code === 'Space' && !reviewFlipped) { e.preventDefault(); flipCard(); }
        if (reviewFlipped && ['1', '2', '3'].indexOf(e.key) >= 0) gradeReview([0, 2, 4][parseInt(e.key, 10) - 1]);
      }
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    selectWay('paste');
    loadSettingsUI();
    refreshCounts();
    bind();
    renderCards();
    listenDsExport();
    // 脚本用 @run-at document-idle，可能晚于本页加载；多探测几次
    checkDsInstalled();
    setTimeout(checkDsInstalled, 400);
    setTimeout(checkDsInstalled, 1500);
  }
  init();
})();
