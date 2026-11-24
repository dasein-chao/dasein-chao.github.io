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
      $('#rawInput').value = Importers.sanitize(res.text);
      previewConv = null; $('#previewPanel').classList.add('hidden');
      updateAutoDetect();
      setLinkStatus('ok', '✅ 读到了对话文本（' + res.text.length + ' 字，通道：' + esc(res.via) + '）。已填进下面的框，点「看识别预览」检查角色对不对。');
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
  function renderSources() {
    var grid = $('#sourceGrid');
    grid.innerHTML = '';
    Importers.list().forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'source-card' + (a.id === selectedSource ? ' selected' : '');
      b.dataset.id = a.id;
      b.innerHTML = '<span class="source-icon">' + (a.icon || '📄') + '</span>' +
        '<div class="source-name">' + esc(a.name) + '</div>' +
        '<div class="source-desc">' + esc(a.desc || '') + '</div>';
      b.addEventListener('click', function () { selectSource(a.id); });
      grid.appendChild(b);
    });
  }
  function selectSource(id) {
    selectedSource = id;
    renderSources();
    var isManual = !!(Importers.get(id) && Importers.get(id).manual);
    $('#manualPanel').classList.toggle('hidden', !isManual);
    $('#pastePanel').classList.toggle('hidden', isManual);
    $('#autoTag').textContent = '';
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

    $('#fileInput').addEventListener('change', function (e) {
      var f = e.target.files[0]; if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        $('#rawInput').value = Importers.sanitize(r.result); updateAutoDetect();
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
    renderSources();
    selectSource('auto');
    loadSettingsUI();
    refreshCounts();
    bind();
    renderCards();
  }
  init();
})();
