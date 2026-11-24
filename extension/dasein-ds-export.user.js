// ==UserScript==
// @name         顿悟卡片·DeepSeek 对话导出器
// @namespace    https://dasein-chao.github.io/
// @version      1.0.0
// @description  在 DeepSeek 页面一键导出完整对话（哪怕几百轮、虚拟滚动看不见的也能拿全），生成顿悟卡片网站可直接导入的 JSON。全程在你自己的浏览器里完成，不上传任何数据。
// @match        https://chat.deepseek.com/*
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

/*
 * 为什么需要它：
 *   DeepSeek 分享页/对话页用虚拟滚动，滚走的消息会从 DOM 卸载，
 *   任何"读页面文字"的办法（含 r.jina.ai）都只能拿到当前可见的一小段。
 *   真正的完整数据在 DeepSeek 自己的接口里。本脚本注入在 chat.deepseek.com
 *   域下，同源调用接口（带浏览器自己的登录态），所以能一次拿到全部消息，
 *   不受跨域(CORS)限制，也不会像公共代理那样被风控限流。
 *
 * 隐私：所有请求都从你的浏览器发往 chat.deepseek.com（它就是页面自己用的接口），
 *       不经过任何第三方服务器。导出的文件只存在你的电脑里。
 *
 * 用法：
 *   1) 打开一段 DeepSeek 对话（自己的对话页 https://chat.deepseek.com/s/xxx
 *      或分享页 https://chat.deepseek.com/share/xxx 都行）。
 *   2) 点页面右下角出现的「导出到顿悟卡片」面板。
 *      - 单个对话：点「复制对话」→ 去 https://dasein-chao.github.io/ 粘贴；
 *        或点「下载 JSON」→ 在网站里用「选择文件导入」。
 *      - 全部对话：点「导出全部会话」→ 下载一个包含所有对话的 JSON 文件。
 */

(function () {
  'use strict';

  var API_BASE = 'https://chat.deepseek.com';

  /* ---------- 工具 ---------- */
  function log() {
    try { console.log('[顿悟导出]', Array.prototype.slice.call(arguments)); } catch (e) {}
  }

  // 解析 DeepSeek 的 userToken（localStorage，可能是裸串或套了几层的 JSON）
  function getToken() {
    var raw = null;
    try { raw = localStorage.getItem('userToken'); } catch (e) {}
    if (!raw) return null;
    function dig(x, depth) {
      if (x == null || depth > 4) return null;
      if (typeof x === 'string') {
        var s = x.trim();
        if (!s) return null;
        if (s[0] === '{' || s[0] === '[') { try { return dig(JSON.parse(s), depth + 1); } catch (e) {} }
        return s;
      }
      if (typeof x === 'object') {
        return dig(x.value || x.token || x.access_token || x.accessToken, depth + 1);
      }
      return null;
    }
    return dig(raw, 0);
  }

  function apiHeaders(withJson) {
    var h = {
      'Accept': 'application/json',
      'x-client-platform': 'web',
      'x-client-version': '2.3.0'
    };
    var token = getToken();
    if (token) h['Authorization'] = 'Bearer ' + token;
    if (withJson) h['Content-Type'] = 'application/json';
    return h;
  }

  // 统一请求：同源、带登录态
  function apiGet(path) {
    return fetch(API_BASE + path, {
      method: 'GET',
      credentials: 'include',
      headers: apiHeaders(false)
    }).then(function (r) {
      if (r.status === 401 || r.status === 403) {
        throw new Error('登录态失效（' + r.status + '），请先刷新 DeepSeek 页面或重新登录');
      }
      if (r.status === 429) {
        throw new Error('请求太频繁被限流（429），请稍等几十秒再试，别连续点');
      }
      if (!r.ok) throw new Error('接口返回 HTTP ' + r.status);
      return r.text();
    }).then(function (t) {
      var j;
      try { j = JSON.parse(t); } catch (e) { throw new Error('接口返回的不是 JSON：' + t.slice(0, 80)); }
      // 业务码：code / biz_code 都可能非 0
      if (j.code != null && j.code !== 0 && j.code !== '0') throw new Error('接口错误 code=' + j.code + ' ' + (j.msg || ''));
      var d = j.data || {};
      if (d.biz_code != null && d.biz_code !== 0 && d.biz_code !== '0') throw new Error('接口错误 biz_code=' + d.biz_code + ' ' + (d.biz_msg || ''));
      return d;
    });
  }

  /* ---------- 从当前 URL 判断要导什么 ---------- */
  function targetInfo() {
    var path = location.pathname;
    var m;
    if ((m = path.match(/\/share\/([^\/?#]+)/))) return { kind: 'share', id: m[1] };
    if ((m = path.match(/\/(?:s|a|c)\/([^\/?#]+)/))) return { kind: 'chat', id: m[1] };
    return { kind: 'none' };
  }

  /* ---------- 拉取消息 ---------- */
  // 分享页：匿名公开接口，一次拿全，最稳
  function fetchShare(shareId) {
    return apiGet('/api/v0/share/content?share_id=' + encodeURIComponent(shareId)).then(function (d) {
      var bd = d.biz_data || {};
      return { title: bd.title || 'DeepSeek 分享对话', raw: bd.messages || [] };
    });
  }

  // 自己的对话页：history_messages，一次拿全（不分页）
  function fetchChat(chatId) {
    return apiGet('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(chatId)).then(function (d) {
      return { title: (d.chat_session && d.chat_session.title) || d.title || 'DeepSeek 对话', raw: d.chat_messages || [] };
    });
  }

  // 会话列表分页（导出全部用）
  function fetchSessionPage(cursor) {
    var q = '/api/v0/chat_session/fetch_page?count=50';
    if (cursor) {
      if (cursor.pinned != null) q += '&lte_cursor.pinned=' + cursor.pinned;
      if (cursor.updated_at != null) q += '&lte_cursor.updated_at=' + cursor.updated_at;
    }
    return apiGet(q).then(function (d) {
      return { sessions: d.chat_sessions || [], hasMore: !!d.has_more };
    });
  }

  /* ---------- 消息归一化 ---------- */
  // 把一条原始消息的 fragments 拼成正文；跳过 THINK（思考过程）和空片段
  function flattenFragments(msg) {
    var fs = msg.fragments;
    if (!Array.isArray(fs) || !fs.length) return msg.content || '';
    var parts = [];
    fs.forEach(function (f) {
      var type = (f.type || '').toUpperCase();
      if (type === 'THINK' || type === 'REASONING') return; // 内部思考，不要
      var c = f.content;
      if (c == null) return;
      c = String(c);
      // 搜索结果片段偶尔把整段 prompt 塞进来，这里不额外猜，只保留有实质内容的
      if (c.trim()) parts.push(c);
    });
    return parts.join('\n').trim();
  }

  function toConversation(raw, title) {
    var out = [];
    raw.forEach(function (m) {
      var role = String(m.role || '').toUpperCase();
      var content = flattenFragments(m);
      if (!content) return;
      if (role === 'USER') out.push({ role: 'user', content: content });
      else if (role === 'ASSISTANT') out.push({ role: 'assistant', content: content });
      // 其它角色（system/tool）忽略
    });
    return {
      app: 'insight-cards',
      format: 'conversation',
      version: 1,
      source: 'deepseek',
      title: title || 'DeepSeek 对话',
      exportedAt: new Date().toISOString(),
      messageCount: out.length,
      messages: out
    };
  }

  // 纯文本版：直接粘进网站输入框就能用
  function toPlainText(conv) {
    return conv.messages.map(function (m) {
      return (m.role === 'assistant' ? '助手：' : '用户：') + m.content;
    }).join('\n\n');
  }

  /* ---------- 输出 ---------- */
  function copyText(text, btn) {
    var done = function () { flash(btn, '✓ 已复制，去网站粘贴'); };
    var fail = function (err) {
      log('copy fail', err);
      // 兜底：弹出一个可选中的 textarea
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:10px;top:10px;width:80vw;height:60vh;z-index:999999;font-size:14px';
      document.body.appendChild(ta); ta.focus(); ta.select();
      flash(btn, '自动复制失败，已弹出文本框，请手动全选复制');
    };
    if (typeof GM_setClipboard === 'function') { try { GM_setClipboard(text, 'text'); done(); return; } catch (e) {} }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail); return;
    }
    fail(new Error('no clipboard api'));
  }

  function download(obj, filename, btn) {
    try {
      var text = JSON.stringify(obj, null, 2);
      var blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      flash(btn, '✓ 已下载 ' + filename);
    } catch (e) { flash(btn, '下载失败：' + e.message); }
  }

  function flash(btn, msg) {
    var old = btn.textContent;
    btn.textContent = msg;
    setTimeout(function () { btn.textContent = old; }, 2600);
  }

  function setStatus(msg) {
    var el = document.getElementById('dasein-ds-status');
    if (el) el.textContent = msg;
    log(msg);
  }

  /* ---------- 面板 UI ---------- */
  function buildPanel() {
    if (document.getElementById('dasein-ds-panel')) return;
    var box = document.createElement('div');
    box.id = 'dasein-ds-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;' +
      'width:250px;background:#fff;color:#1f2430;border-radius:14px;' +
      'box-shadow:0 8px 32px rgba(20,24,40,.22);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'border:1px solid #e6e8ef;overflow:hidden;';
    box.innerHTML =
      '<div id="dasein-ds-head" style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:8px;' +
      'background:linear-gradient(135deg,#5b7cfa,#7c5cfa);color:#fff;font-weight:600">' +
      '<span>✨</span><span>导出到顿悟卡片</span><span style="margin-left:auto" id="dasein-ds-toggle">▾</span></div>' +
      '<div id="dasein-ds-body" style="padding:12px">' +
      '<div id="dasein-ds-status" style="color:#6b7280;font-size:12px;margin-bottom:10px;min-height:16px">就绪 · 先打开一段对话</div>' +
      '<button id="ds-copy" style="width:100%;margin-bottom:8px;padding:8px;border:0;border-radius:8px;background:#eef1ff;color:#3b4fd8;cursor:pointer;font-weight:600">复制当前对话（粘贴到网站）</button>' +
      '<button id="ds-json" style="width:100%;margin-bottom:8px;padding:8px;border:0;border-radius:8px;background:#f4f5f8;color:#374151;cursor:pointer">下载当前对话 JSON</button>' +
      '<button id="ds-all" style="width:100%;padding:8px;border:0;border-radius:8px;background:#f4f5f8;color:#374151;cursor:pointer">导出全部会话（下载 JSON）</button>' +
      '<div style="margin-top:10px;font-size:11px;color:#9aa0ad">虚拟滚动看不见的历史消息也能完整导出。数据只在你本地，不上传。</div>' +
      '</div>';
    document.body.appendChild(box);

    document.getElementById('dasein-ds-head').addEventListener('click', function () {
      var body = document.getElementById('dasein-ds-body');
      var hidden = body.style.display === 'none';
      body.style.display = hidden ? '' : 'none';
      document.getElementById('dasein-ds-toggle').textContent = hidden ? '▾' : '▸';
    });

    document.getElementById('ds-copy').addEventListener('click', function () {
      var btn = this;
      setStatus('正在读取完整对话…');
      getCurrentConv().then(function (conv) {
        setStatus('共 ' + conv.messageCount + ' 条消息');
        copyText(toPlainText(conv), btn);
      }).catch(onErr);
    });

    document.getElementById('ds-json').addEventListener('click', function () {
      var btn = this;
      setStatus('正在读取完整对话…');
      getCurrentConv().then(function (conv) {
        download(conv, safeName(conv.title) + '.json', btn);
        setStatus('共 ' + conv.messageCount + ' 条消息');
      }).catch(onErr);
    });

    document.getElementById('ds-all').addEventListener('click', function () {
      var btn = this;
      exportAll(btn).catch(onErr);
    });

    function onErr(e) {
      setStatus('失败：' + (e && e.message ? e.message : e));
    }
  }

  function safeName(s) {
    return String(s || 'deepseek').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  }

  function getCurrentConv() {
    var t = targetInfo();
    if (t.kind === 'share') return fetchShare(t.id).then(function (r) { return toConversation(r.raw, r.title); });
    if (t.kind === 'chat') return fetchChat(t.id).then(function (r) { return toConversation(r.raw, r.title); });
    return Promise.reject(new Error('请先打开一段 DeepSeek 对话（自己对话页或分享页）再导出'));
  }

  // 导出全部会话：分页列会话 → 逐个拉消息 → 打包成一个 bundle
  function exportAll(btn) {
    if (!getToken()) return Promise.reject(new Error('导出全部需要先登录自己的 DeepSeek 账号'));
    setStatus('正在列出所有会话…');
    var sessions = [];
    var cursor = null;
    var page = 0;
    function nextPage() {
      return fetchSessionPage(cursor).then(function (r) {
        sessions = sessions.concat(r.sessions);
        page++;
        setStatus('已列出 ' + sessions.length + ' 个会话…');
        if (r.hasMore && r.sessions.length && page < 400) {
          var last = r.sessions[r.sessions.length - 1];
          cursor = { pinned: last.pinned ? 1 : 0, updated_at: last.updated_at };
          return nextPage();
        }
        return null;
      });
    }
    return nextPage().then(function () {
      if (!sessions.length) throw new Error('没找到会话');
      var convs = [];
      var i = 0;
      function nextConv() {
        if (i >= sessions.length) return null;
        var s = sessions[i++];
        setStatus('导出中 ' + i + '/' + sessions.length + '：' + (s.title || '').slice(0, 18));
        return fetchChat(s.id).then(function (r) {
          var conv = toConversation(r.raw, r.title || s.title);
          if (conv.messages.length) convs.push(conv);
        }).catch(function (e) {
          log('skip session', s.id, e.message); // 单个失败跳过，不中断整体
        }).then(nextConv);
      }
      return nextConv().then(function () {
        var bundle = {
          app: 'insight-cards', format: 'conversation-bundle', version: 1,
          source: 'deepseek', exportedAt: new Date().toISOString(),
          conversationCount: convs.length, conversations: convs
        };
        download(bundle, 'deepseek-全部对话-' + sessions.length + '个.json', btn);
        setStatus('完成：' + convs.length + ' 个对话');
      });
    });
  }

  /* ---------- 启动 ---------- */
  function init() {
    // 菜单命令（油猴菜单里也能触发）
    if (typeof GM_registerMenuCommand === 'function') {
      try {
        GM_registerMenuCommand('顿悟卡片：复制当前对话', function () {
          getCurrentConv().then(function (c) { copyText(toPlainText(c), { textContent: '', style: {} }); }).catch(log);
        });
      } catch (e) {}
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildPanel);
    else buildPanel();
  }
  init();
})();
