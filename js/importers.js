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
      if (/(用户|user|我|助手|assistant|ai|deepseek|glm)/i.test(s)) score += 3;
      if (/(^|\n)\s*(用户|助手|user|assistant|ai)\s*[:：]/im.test(s)) score += 5;
      var lines = s.split('\n');
      var marked = lines.filter(function (l) { return detectRoleLine(l); }).length;
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

  global.Importers = {
    register: register, list: list, parse: parse, autoDetect: autoDetect,
    get: function (id) { return ADAPTERS[id]; }
  };
})(window);
