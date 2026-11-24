/* importers.js — 对话导入适配器（可扩展接口）
 * 每个适配器负责把「某个来源的原始对话文本」解析成统一格式：
 *   { source, title, messages: [{role:'user'|'assistant', content}] }
 * 想支持新平台？在文件末尾 register 一个新适配器即可。
 */
(function (global) {
  'use strict';

  var ADAPTERS = {};

  function register(id, adapter) {
    ADAPTERS[id] = Object.assign({ id: id }, adapter);
    return ADAPTERS[id];
  }

  function list() {
    return Object.keys(ADAPTERS).map(function (id) {
      return { id: id, name: ADAPTERS[id].name, desc: ADAPTERS[id].desc, icon: ADAPTERS[id].icon };
    });
  }

  /* ---------- 通用行解析：识别「角色标记 + 内容」 ---------- */
  function detectRoleLine(line) {
    var t = line.trim();
    // 独占一行的角色名
    if (/^(用户|user|我|human|提问者|question|q)$/i.test(t)) return { role: 'user', inline: '' };
    if (/^(助手|assistant|ai|gpt|chatgpt|deepseek|deep seek|ds|glm|智谱|模型|bot|answer|回答|答|a)$/i.test(t)) return { role: 'assistant', inline: '' };
    // 带冒号（中英文均可），内容可在同一行
    var m = t.match(/^(用户|user|我|提问|问|question|human|client)\s*[:：]\s*(.*)$/i);
    if (m) return { role: 'user', inline: m[2] };
    m = t.match(/^(助手|assistant|ai|gpt|chatgpt|deepseek|ds|glm|智谱|模型|回答|answer|bot)\s*[:：]\s*(.*)$/i);
    if (m) return { role: 'assistant', inline: m[2] };
    // 无冒号但多字符标记 + 空格
    m = t.match(/^(用户|user|question|human|助手|assistant|chatgpt|deepseek|glm|智谱|模型|answer)\s+(.+)$/i);
    if (m) return { role: /^(用户|user|question|human)/i.test(m[1]) ? 'user' : 'assistant', inline: m[2] };
    return null;
  }

  function parseLabelled(raw) {
    var lines = String(raw || '').replace(/\r\n?/g, '\n').split('\n');
    var msgs = [];
    var cur = null;
    for (var i = 0; i < lines.length; i++) {
      var det = detectRoleLine(lines[i]);
      if (det) {
        cur = { role: det.role, content: det.inline || '' };
        msgs.push(cur);
      } else if (cur) {
        cur.content += (cur.content ? '\n' : '') + lines[i];
      } else if (lines[i].trim()) {
        cur = { role: 'user', content: lines[i] };
        msgs.push(cur);
      }
    }
    return msgs.filter(function (m) { return m.content.trim(); });
  }

  function wrapMessages(messages, source, title) {
    var clean = (messages || []).filter(function (m) {
      return m && m.content && String(m.content).trim();
    }).map(function (m) {
      return { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).trim() };
    });
    return {
      source: source,
      title: title || '未命名对话',
      createdAt: new Date().toISOString(),
      messages: clean
    };
  }

  function guessTitle(messages) {
    var first = (messages.find(function (m) { return m.role === 'user'; }) || messages[0]);
    if (!first) return '未命名对话';
    var line = String(first.content).split('\n').find(function (l) { return l.trim(); }) || '';
    return line.trim().slice(0, 40) || '未命名对话';
  }

  /* ---------- 内置适配器 ---------- */

  // 通用：带角色标记的文本（覆盖 DeepSeek / GLM / 大部分手动复制）
  register('auto', {
    name: '通用 / 自动识别',
    icon: '✨',
    desc: '最常见格式：带「用户 / 助手 / User / AI」等标记的文本，自动识别',
    detect: function (raw) {
      var s = String(raw || '');
      var score = 0;
      // 只看「真正的角色标记行」，不要拿正文里的「我/你」当信号——
      // 否则 DS 剥壳后无标记的整段对话会被误判成 auto，全部塞进一条消息。
      var lines = s.split('\n');
      var marked = lines.filter(function (l) { return detectRoleLine(l); }).length;
      if (marked > 0) score += 3;
      if (/(^|\n)\s*(用户|助手|user|assistant|ai|deepseek|gemini)\s*[:：]/im.test(s)) score += 5;
      score += Math.min(marked, 10);
      return score;
    },
    parse: function (raw) {
      var msgs = parseLabelled(raw);
      return wrapMessages(msgs, 'auto', guessTitle(msgs));
    }
  });

  // 纯文本对话：没有标记，成对出现（第1条=我，第2条=AI，交替）
  register('plain', {
    name: '无标记纯文本',
    icon: '📝',
    desc: '没有角色标记、按空行分段的对话，按顺序交替识别为「我 / AI」',
    detect: function (raw) {
      var s = String(raw || '');
      if (detectRoleLine(s.split('\n')[0] || '')) return 0;
      return /(\n\s*\n)/.test(s) ? 2 : 0;
    },
    parse: function (raw) {
      var blocks = String(raw || '').replace(/\r\n?/g, '\n').split(/\n\s*\n+/).filter(function (b) { return b.trim(); });
      var msgs = blocks.map(function (b, i) {
        return { role: i % 2 === 0 ? 'user' : 'assistant', content: b.trim() };
      });
      return wrapMessages(msgs, 'plain', guessTitle(msgs));
    }
  });

  // ChatGPT 分享文本：「You said: / ChatGPT said:」
  register('chatgpt', {
    name: 'ChatGPT',
    icon: '🟢',
    desc: 'ChatGPT 分享或复制的文本（You said: / ChatGPT said:）',
    detect: function (raw) {
      var s = String(raw || '');
      return /you said:|chatgpt said:/i.test(s) ? 10 : 0;
    },
    parse: function (raw) {
      var s = String(raw || '');
      var msgs = [];
      var re = /(you said:|chatgpt said:)/gi;
      var parts = s.split(re);
      for (var i = 1; i < parts.length; i += 2) {
        var role = /you/i.test(parts[i]) ? 'user' : 'assistant';
        msgs.push({ role: role, content: (parts[i + 1] || '').trim() });
      }
      if (!msgs.length) msgs = parseLabelled(s);
      return wrapMessages(msgs, 'chatgpt', guessTitle(msgs));
    }
  });

  // JSON：支持标准 messages 数组 / ChatGPT 导出 mapping
  register('json', {
    name: 'JSON 数据',
    icon: '{}',
    desc: '包含 messages 数组的 JSON，或 ChatGPT 导出的 conversations.json',
    detect: function (raw) {
      var s = String(raw || '').trim();
      if ((s[0] === '{' || s[0] === '[') && (s.indexOf('messages') >= 0 || s.indexOf('mapping') >= 0)) return 12;
      return 0;
    },
    parse: function (raw) {
      var data = JSON.parse(String(raw));
      var msgs = [];
      if (Array.isArray(data)) {
        data.forEach(function (x) { msgs.push({ role: x.role, content: x.content || x.text || '' }); });
      } else if (Array.isArray(data.messages)) {
        data.messages.forEach(function (x) { msgs.push({ role: x.role, content: typeof x.content === 'string' ? x.content : JSON.stringify(x.content) }); });
      } else if (data.mapping) {
        Object.keys(data.mapping).forEach(function (k) {
          var m = data.mapping[k] && data.mapping[k].message;
          if (!m || !m.content) return;
          var role = (m.author && m.author.role) || 'user';
          var parts = (m.content.parts || []).filter(function (p) { return typeof p === 'string'; });
          msgs.push({ role: role === 'assistant' ? 'assistant' : 'user', content: parts.join('\n') });
        });
      }
      return wrapMessages(msgs, 'json', data.title || guessTitle(msgs));
    }
  });

  // 手动：两段式输入（最稳，适合任何来源）
  register('manual', {
    name: '手动两段',
    icon: '✍️',
    desc: '自己分别粘贴「我的疑问」和「AI 的解答」，任何来源都能用',
    manual: true,
    detect: function () { return 0; },
    parse: function (obj) {
      var msgs = [];
      if (obj && obj.question && String(obj.question).trim()) msgs.push({ role: 'user', content: String(obj.question).trim() });
      if (obj && obj.answer && String(obj.answer).trim()) msgs.push({ role: 'assistant', content: String(obj.answer).trim() });
      return wrapMessages(msgs, 'manual', (obj && obj.title) || guessTitle(msgs));
    }
  });

  /* ---------- 对外接口 ---------- */
  function parse(id, raw) {
    var a = ADAPTERS[id] || ADAPTERS.auto;
    return a.parse(raw);
  }

  function autoDetect(raw) {
    var best = 'auto', bestScore = -1;
    list().forEach(function (a) {
      var ad = ADAPTERS[a.id];
      if (ad.manual || typeof ad.detect !== 'function') return;
      var sc = ad.detect(raw) || 0;
      if (sc > bestScore) { bestScore = sc; best = a.id; }
    });
    return best;
  }

  /* ============================================================
   * 统一清洗层（sanitize）：所有导入路径共用
   * 把 r.jina.ai / 分享页复制出来的 markdown 噪音清掉，输出干净的
   * 「用户：/ 助手：」对话文本，再交给解析器和算法。
   * 目的：① 界面不显示一堆 # 和 URL（美观）② 噪音不污染卡点/顿悟/关键词算法。
   * ============================================================ */
  function cleanLine(line) {
    var t = String(line || '');
    // 元信息行整行丢弃
    if (/^\s*(Final URL|Title|URL Source|Source|Published Time|Markdown Content|Warning)\s*[:：]/i.test(t)) return null;
    // 裸 URL 行丢弃
    if (/^\s*(https?:\/\/|www\.)\S+\s*$/i.test(t)) return null;
    // markdown 水平分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(t)) return null;
    /* --- r.jina.ai / DeepSeek 分享页：联网搜索结果外壳噪音（DS 分享读不出的根因） --- */
    // "Found 16 web pages" / "Found 8 results" / "Found 5 sources"
    if (/^\s*Found\s+\d+\s+(web\s*pages?|results?|sources?|websites?)\b/i.test(t)) return null;
    // r.jina.ai 图片占位：![Image 1] 或 ![Image 1](url)，可带前导空格
    if (/^\s*!\[[^\]]*\]\s*(\([^)]*\))?\s*$/.test(t)) return null;
    // 括号包裹的裸 URL（DeepSeek 来源图标多为这种）：(https://cdn.deepseek.com/...)
    if (/^\s*\(\s*https?:\/\/[^\s)]+\s*\)\s*$/i.test(t)) return null;
    // 任意位置的 DeepSeek site-icons 图标 URL：抹掉，整行若只剩它就丢弃
    if (/cdn\.deepseek\.com\/site-icons/i.test(t)) {
      t = t.replace(/\(?\s*https?:\/\/[^\s)]*site-icons[^\s)]*\s*\)?/gi, '').trim();
      if (!t) return null;
    }
    // DS 联网回答的「搜索自述」过渡句：不是知识点，且会污染标题/卡点，整行丢弃
    if (/^\s*(搜索结果显示|搜索到的结果|以下是搜索结果|根据搜索结果|我搜索了|为了全面获取信息|我需要进一步(筛选|查找|获取|搜索|整理))/i.test(t) && t.length < 90) return null;
    // 去 markdown 标题 # 前缀、加粗符、反引号；去无序列表符号（保留数字编号）
    t = t.replace(/^\s*#{1,6}\s+/, '')
         .replace(/\*\*/g, '').replace(/__/g, '')
         .replace(/`/g, '')
         .replace(/^\s*[-*+]\s+/, '');
    return t;
  }

  // 识别行首角色标记，输出 {role, content}
  function matchRole(line) {
    var s = String(line || '').trim();
    var m = s.match(/^(You said|You asked|User said|You|User|Human)\b\s*[:：]?\s+(.+)$/i);
    if (m) return { role: 'user', content: m[2].trim() };
    m = s.match(/^(Gemini said|ChatGPT said|Assistant said|Assistant|AI|Model|Bot|Gemini|ChatGPT)\b\s*[:：]?\s+(.+)$/i);
    if (m) return { role: 'assistant', content: m[2].trim() };
    m = s.match(/^(用户|我|提问|问)\s*[:：]\s*(.*)$/);
    if (m) return { role: 'user', content: m[2].trim() };
    m = s.match(/^(助手|回答|答)\s*[:：]\s*(.*)$/i);
    if (m) return { role: 'assistant', content: m[2].trim() };
    if (/^(用户|我|user|human)$/i.test(s)) return { role: 'user', content: '' };
    if (/^(助手|assistant|ai|model|gemini|chatgpt)$/i.test(s)) return { role: 'assistant', content: '' };
    return null;
  }

  // 归一化后比较两段文字是否为「同一句话/复述」
  function normCmp(s) {
    return String(s || '').replace(/[\s，。！？、,.:;：；!?"'"`*_#\-—…~～]/g, '').toLowerCase();
  }
  function isEchoOfUser(content, lastUser) {
    var a = normCmp(content), b = normCmp(lastUser);
    if (!a || !b) return false;
    if (a === b) return true;
    // 一段完整包含另一段且长度接近：视为「用户问题的复述」
    if (a.length >= 8 && b.length >= 8 && (a.indexOf(b) >= 0 || b.indexOf(a) >= 0)) {
      var ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
      if (ratio >= 0.75) return true;
    }
    return false;
  }

  function isShareRender(text) {
    return /(You said|Gemini said|Final URL\s*:|Markdown Content\s*:|URL Source\s*:|^\s*#{1,6}\s)/im.test(String(text || ''));
  }

  // 分享页渲染文本：以 You said 为用户轮分隔，其后的内容归助手
  function sanitizeShare(text) {
    var lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    var out = [], state = 'none', lastUserContent = '';
    lines.forEach(function (line) {
      var t = cleanLine(line);
      if (t === null) return;
      t = t.trim();
      if (!t) return;
      var role = matchRole(t);
      if (role) {
        out.push((role.role === 'user' ? '用户：' : '助手：') + role.content);
        state = role.role;
        if (role.role === 'user') lastUserContent = role.content;
      } else if (state === 'user') {
        // 用户标记后的第一段 = 助手回答开始（r.jina.ai 不标 Gemini said）。
        // 但分享页常在正文开头把用户问题再复述一遍，这种「用户：X / 助手：X」是假回答，跳过。
        if (isEchoOfUser(t, lastUserContent)) return; // 丢弃复述，保持 state='user' 等真正回答
        out.push('助手：' + t);
        state = 'assistant';
      } else {
        out.push(t); // 并入当前角色
      }
    });
    return out.join('\n').trim();
  }

  // 通用后处理：删掉「助手：X」紧跟在「用户：X」后面、内容其实是用户问题复述的假回答行。
  // 无论文本走了分享分支还是普通分支，只要成品里出现这种相邻重复，都清掉。
  function dropEchoPairs(text) {
    var lines = String(text || '').split('\n');
    var out = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var m = line.match(/^助手[:：]\s*(.+)$/);
      var isEcho = false;
      if (m && out.length) {
        // 往前找最近的一条「用户：」行（只比对紧邻几行），内容若是复述则判定为真
        for (var j = out.length - 1; j >= 0 && j >= out.length - 3; j--) {
          var um = out[j].match(/^用户[:：]\s*(.+)$/);
          if (um && isEchoOfUser(m[1], um[1])) { isEcho = true; break; }
          if (um) break;
        }
      }
      if (isEcho) {
        // 丢弃这条复述行；紧随其后的无标记续行是真回答，给它们补上「助手：」
        i++;
        while (i < lines.length) {
          var nxt = lines[i].trim();
          if (!nxt) { i++; continue; }
          if (/^(用户|助手|我|提问|问|回答|答|You|Gemini|Assistant|User|AI|Human)[:：]/i.test(nxt)) break; // 下个角色开始
          out.push('助手：' + lines[i]);
          i++;
        }
        continue;
      }
      out.push(line);
      i++;
    }
    return out.join('\n');
  }

  function sanitize(raw) {
    var s = String(raw || '');
    if (!s.trim()) return '';
    var cleaned;
    if (isShareRender(s)) {
      cleaned = sanitizeShare(s);
    } else {
      // 普通文本：只清噪音，保留原有对话结构
      var lines = s.replace(/\r\n?/g, '\n').split('\n');
      var out = [];
      lines.forEach(function (line) {
        var t = cleanLine(line);
        if (t === null) return;
        out.push(t);
      });
      cleaned = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    }
    // 出口统一去「用户X/助手X」复述对，覆盖所有分支
    return dropEchoPairs(cleaned).trim();
  }

  global.Importers = {
    register: register, list: list, parse: parse, autoDetect: autoDetect,
    sanitize: sanitize,
    get: function (id) { return ADAPTERS[id]; }
  };

  /* ============================================================
   * 链接读取（LinkFetch）：把「分享链接」变成对话文本
   * ------------------------------------------------------------
   * 背景：Gemini / ChatGPT 的「分享对话」会生成公开链接（快照），
   *       任何人拿到链接都能读。纯静态网页跨域直连会被 CORS 拦，
   *       所以走公共只读代理中转，多个代理依次兜底。
   * 注意：对话内容会经过第三方代理，敏感内容请用手动复制。
   * 输出：Promise<string> 清理后的对话纯文本，交给现有适配器解析。
   * ============================================================ */
  var LinkFetch = (function () {
    // 只接受 http(s)，且是我们认识的分享域名（放宽松一点，容忍新域名）
    function normalizeUrl(raw) {
      var s = String(raw || '').trim();
      if (!s) return null;
      if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
      try { new URL(s); } catch (e) { return null; }
      return s;
    }

    function isShareLink(raw) {
      var s = String(raw || '').trim();
      return /(g\.co\/gemini\/share|gemini\.google\.com\/(share|app)|chatgpt\.com\/(share|s)\/|share\.gemini\.google|chat\.deepseek\.com\/(share|s)\/|deepseek\.com\/share)/i.test(s);
    }

    // 单个请求超时（毫秒）：超时就换下一个通道，避免一直卡住
    var TIMEOUT = 20000;

    function fetchWithTimeout(url, opt) {
      return new Promise(function (resolve, reject) {
        var done = false;
        var timer = setTimeout(function () {
          if (!done) { done = true; reject(new Error('超时')); }
        }, TIMEOUT);
        fetch(url, opt).then(function (r) {
          if (done) return; done = true; clearTimeout(timer); resolve(r);
        }).catch(function (e) {
          if (done) return; done = true; clearTimeout(timer); reject(e);
        });
      });
    }

    function okText(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }

    // 公共只读代理列表：各返回一个 Promise<string>（代理抓到的原始文本）
    // r.jina.ai 是「服务端渲染型」代理——它在自己服务器上跑浏览器渲染动态页，
    // 正好能读 Gemini/ChatGPT 分享页这种 JS 动态页面，故列为首选。
    var PROXIES = [
      {
        name: 'r.jina.ai',
        get: function (u) { return fetchWithTimeout('https://r.jina.ai/' + encodeURI(u)).then(okText); }
      },
      {
        name: 'allorigins',
        get: function (u) { return fetchWithTimeout('https://api.allorigins.win/raw?url=' + encodeURIComponent(u)).then(okText); }
      },
      {
        name: 'codetabs',
        get: function (u) { return fetchWithTimeout('https://api.codetabs.com/v1/proxy/?quest=' + encodeURIComponent(u)).then(okText); }
      }
    ];

    // 把代理返回的 markdown / HTML 清理成对话文本
    function cleanText(txt) {
      var s = String(txt || '');
      // 1. 去掉 jina 的元信息行
      s = s.replace(/^Title:.*$/gm, '')
           .replace(/^URL Source:.*$/gm, '')
           .replace(/^Markdown Content:\s*$/gm, '')
           .replace(/^Source:.*$/gm, '')
           .replace(/^Published Time:.*$/gm, '')
           .replace(/^Warning:.*$/gm, '');
      // 2. 若代理返回 HTML，去标签
      if (/<[a-z][\s\S]*>/i.test(s) && s.indexOf('<') < 200) {
        s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
             .replace(/<style[\s\S]*?<\/style>/gi, ' ')
             .replace(/<br\s*\/?>/gi, '\n')
             .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
             .replace(/<[^>]+>/g, ' ');
      }
      // 3. 关键：r.jina.ai 把角色词加粗，返回形如 **You said:** 内容。
      //    先去掉 markdown 的 **，再把行首角色标记统一成「用户：/ 助手：」。
      s = s.replace(/\*\*/g, '');
      s = s.replace(/^[ \t]*(You said|You|User|Human)[ \t]*[:：][ \t]*/gim, '用户：')
           .replace(/^[ \t]*(Gemini said|ChatGPT said|Assistant|AI|Model|Gemini|ChatGPT)[ \t]*[:：][ \t]*/gim, '助手：');
      // 4. 逐行剥离平台外壳：Found N web pages / ![Image N] / (图标网址) / site-icons 等
      //    复用统一清洗层的 cleanLine，DS 分享读不出的根因就在这里。
      s = s.split('\n').map(function (l) { return cleanLine(l); })
           .filter(function (l) { return l !== null; }).join('\n');
      s = s.replace(/\n{3,}/g, '\n\n').trim();
      return s;
    }

    // 判断读回来的文本是不是「真对话」，还是纯网页导航外壳（登录页/落地页/Cookie 提示）。
    // 原则：宁可「猜一下」把正文交出去让用户核对，也不要动辄判失败。
    // 真正的空壳是：没有角色标记 + 全是短标签/网址 + 几乎没有一句完整正文。
    function looksLikeConversation(txt) {
      var s = String(txt || '');
      // 1) 强信号：有明确的对话角色标记（含 DS 的「用户 / DeepSeek / 助手」等）
      if (/(You said|Gemini said|ChatGPT said|^用户[:：]|^助手[:：]|^我[:：]|^AI[:：]|^DeepSeek[:：]|^深度求索[:：])/im.test(s)) return true;
      var lines = s.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
      if (!lines.length) return false;
      var urlLines = 0, bracketLines = 0, longLines = 0, buildingLines = 0;
      lines.forEach(function (l) {
        if (/^[\(\[]?\s*https?:\/\/\S+[\)\]]?\s*$/i.test(l)) urlLines++;
        if (/^\[[^\]]{1,40}\]$/.test(l)) bracketLines++;
        // 一句像样的正文：>=12 个中英文字（放宽，DS 回答首行可能较短）
        var wordChars = l.replace(/[^\u4e00-\u9fa5A-Za-z]/g, '').length;
        if (wordChars >= 12 && !/https?:\/\//i.test(l)) longLines++;
        // 还在生成/展开中的句子（>=6 字），作为弱证据
        else if (wordChars >= 6 && !/https?:\/\//i.test(l)) buildingLines++;
      });
      var shellLines = urlLines + bracketLines;
      // 有实质正文（哪怕只有 1 句长的）→ 猜它是对话，交出去让用户核对
      if (longLines >= 1) return true;
      // 没有长句但有一堆半截句，且外壳不算离谱 → 也猜一下
      if (buildingLines >= 3 && shellLines / lines.length < 0.5) return true;
      // 剩下的：满屏网址/短标签、几乎没有正文 → 判定为空壳
      return false;
    }

    // 依次尝试代理，返回第一个非空结果；全部失败则抛出可读错误
    function fetchLink(raw, onProgress) {
      var url = normalizeUrl(raw);
      if (!url) return Promise.reject(new Error('链接格式不对，检查一下'));
      var i = 0, lastErr = null;
      function next() {
        if (i >= PROXIES.length) {
          var lastMsg = (lastErr && lastErr.message) || '';
          var hint;
          if (/deepseek/i.test(url)) {
            // DS 分享页常只被代理渲染出联网搜索外壳，剥壳后就没正文了——
            // 不管报「太短」还是「空壳」，都给同一个明确、可执行的提示。
            hint = 'DeepSeek 这个链接只抓到了联网搜索的外壳，没抓到对话正文（分享页多需登录，代理只能渲染出搜索结果）。最稳的办法：在 DeepSeek 里全选复制对话文字，贴到下面的框里，点「整理格式」。';
          } else if (/网页导航|空壳|太短/.test(lastMsg)) {
            hint = '读到的都是网页导航，不是对话——这个分享链接多半需要登录或已失效。请重新生成分享链接，或改用手动复制对话文字。';
          } else {
            hint = '所有读取通道都失败了。可能原因：网络不通、链接需登录、或对方禁止抓取。请改用手动复制。';
          }
          return Promise.reject(new Error(hint + (lastErr ? '（' + lastMsg + '）' : '')));
        }
        var p = PROXIES[i++];
        if (onProgress) onProgress(p.name);
        return p.get(url).then(function (txt) {
          var cleaned = cleanText(txt);
          if (cleaned.length < 20) throw new Error('读到的内容太短');
          // 关键校验：读到的必须是「对话」，不是网页导航外壳
          if (!looksLikeConversation(cleaned)) {
            throw new Error('读到的是网页导航（不是对话）。链接可能需登录或已失效');
          }
          return { text: cleaned, via: p.name, url: url };
        }).catch(function (e) { lastErr = e; return next(); });
      }
      return next();
    }

    return { fetchLink: fetchLink, isShareLink: isShareLink, normalizeUrl: normalizeUrl, cleanText: cleanText, looksLikeConversation: looksLikeConversation, proxies: PROXIES.map(function (p) { return p.name; }) };
  })();

  global.LinkFetch = LinkFetch;
})(window);
