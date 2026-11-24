/* analyzer.js — 分析引擎
 * 双模式：
 *  1) 本地模式（默认，无需 key）：基于规则从旧对话里抽取「金句 / 卡点 / 题目 / 关键词」，
 *     生成卡片草稿，再由你手动润色。不是语义理解，但开箱即用。
 *  2) AI 模式（可选）：调用 OpenAI 兼容 API（DeepSeek / GLM / 自定义），深度归纳。
 */
(function (global) {
  'use strict';

  /* ======================= 本地规则引擎 ======================= */

  var STOP = ('的 了 和 是 在 我 你 他 她 它 我们 你们 他们 这 那 这个 那个 一个 一种 就是 不是 但是 然后 因为 所以 如果 虽然 而且 或者 ' +
    '什么 怎么 为什么 如何 吗 呢 吧 啊 哦 嗯 把 被 让 给 从 到 对 与 跟 和 也 都 还 就 才 很 更 最 太 已经 可能 应该 ' +
    '可以 需要 觉得 认为 知道 理解 意思 时候 问题 东西 一下 一点 这些 那些 自己 它们 这里 那里 这样 那样').split(/\s+/);
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = 1; });
  // 单字虚词：出现在词组首尾就认为该词组是切碎的垃圾
  var EDGE_STOP = ('的 了 和 是 在 我 你 他 她 它 这 那 个 一 就 都 还 也 而 被 把 让 给 从 到 对 与 跟 吗 呢 吧 啊 哦 嗯 很 更 最 太 又 再 才 并 且 或 但 之 其 于 以 为').split(/\s+/);
  var EDGESET = {};
  EDGE_STOP.forEach(function (w) { EDGESET[w] = 1; });

  // 疑问 / 困惑 / 卡点信号
  var CONFUSE_WORDS = ['为什么', '怎么', '如何', '是不是', '区别', '不同', '不懂', '不明白', '卡住', '卡在', '困惑',
    '但是', '难道', '哪里错', '哪里不对', '坑', '容易错', '一直以为', '原来', '错了', '搞混', '分不清', '什么意思',
    '？', '?', '为何', '凭什么', '纠结'];

  // 顿悟信号
  var AHA_WORDS = ['哦', '原来如此', '懂了', '明白了', '恍然大悟', '所以就是', '这样就', '通了', '对对对', '原来',
    '我懂', '开窍', '学到了', '竟然', '居然', '想通'];

  // 金句 / 结论句模式（AI 回答里最值得记的句子）
  var INSIGHT_PATTERNS = [
    /本质(上)?是|本质上|核心(是)?|关键是|真正的|实际上|其实|说白了|归根结底/,
    /记住|重点是|要注意|注意|容易错|误区|坑|关键是|别忘/,
    /不是.{1,40}而是|并不是|不在于|区别于/,
    /只有当|前提是|必要条件|充分条件|意味着|等价于/,
    /指的是|定义为|称为|叫做|就是(指)?|等于/,
    /所以|因此|结论|总之|一句话|简单说|换句话说/
  ];

  function countHits(text, words) {
    var n = 0;
    words.forEach(function (w) { if (text.indexOf(w) >= 0) n++; });
    return n;
  }

  function splitSentences(text) {
    return String(text || '')
      .replace(/\r\n?/g, '\n')
      .split(/(?<=[。！？!?；;])|\n+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length >= 4; });
  }

  // AI 回答开头常先复述用户的问题（"你问的是……""你想了解……"）。
  // 这类句子不是知识点，且会切出「看不懂/懂报错」之类碎片挤掉真术语、让填空题挖在复述上。
  // 这里在喂给分析前把它们剥掉，保留后面的实质内容。
  var ECHO_RE = /^(好的[，,]?\s*)?(你问的是|你刚才问(的是)?|你想问(的是)?|你想了解(的是)?|你的问题是|关于你(提到|说|问)(的)?问题?|针对你(的)?问题|你问到|你提到)[：:]?\s*/;
  function stripEcho(answer, question) {
    var sents = splitSentences(answer);
    if (!sents.length) return String(answer || '');
    var qCore = String(question || '').trim().split('\n')[0].replace(/[。！？!?]+$/, '');
    var out = [];
    sents.forEach(function (s) {
      var m = s.match(ECHO_RE);
      if (!m) { out.push(s); return; }
      var rest = s.slice(m[0].length);
      // 引导词后面若跟着用户原话，一并去掉
      if (qCore && rest.indexOf(qCore) === 0) rest = rest.slice(qCore.length).replace(/^[，,。：:\s]+/, '');
      // 剥完还有实质内容（>=8字）就保留，否则整句丢弃
      if (rest.length >= 8) out.push(rest);
    });
    return out.join(' ') || String(answer || '');
  }

  function scoreSentence(s) {
    var sc = 0;
    INSIGHT_PATTERNS.forEach(function (re, i) { if (re.test(s)) sc += (i === 0 || i === 1 ? 3 : 2); });
    if (/[A-Za-z]{2,}|`[^`]+`/.test(s)) sc += 1;      // 含术语/代码
    if (s.length >= 12 && s.length <= 120) sc += 1;   // 长度适中
    if (/[：:]/.test(s)) sc += 1;                       // 定义结构
    return sc;
  }

  // 提取金句（正确理解的核心）
  function extractInsight(answer, topN) {
    var sents = splitSentences(answer);
    var ranked = sents.map(function (s, i) { return { s: s, i: i, sc: scoreSentence(s) }; })
      .filter(function (x) { return x.sc > 0; })
      .sort(function (a, b) { return b.sc - a.sc; });
    var picked = ranked.slice(0, topN || 3).sort(function (a, b) { return a.i - b.i; });
    var text = picked.map(function (x) { return x.s.replace(/^[•\-*]\s*/, ''); }).join(' ');
    if (!text && sents.length) text = sents.slice(0, 2).join(' '); // 兜底：取前两句
    return text.slice(0, 500);
  }

  // 轻量中文关键词提取（n-gram 词频 + 停用词 + 引号/代码/英文优先）
  function extractKeywords(text, limit) {
    var kws = [];
    var quoted = String(text).match(/[`"'「」『』]([^`"'「」『』]{2,20})[`"'「」『』]/g) || [];
    quoted.forEach(function (q) { kws.push(q.replace(/[`"'「」『』]/g, '').trim()); });
    var en = String(text).match(/[A-Za-z][A-Za-z0-9_.#-]{1,20}/g) || [];
    en.forEach(function (w) { kws.push(w); });

    var clean = String(text).replace(/[^\u4e00-\u9fa5]+/g, ' ');
    var freq = {};
    // 统计 2 字和 3 字词，都要求重复出现；3 字词能让「作用域」这种完整词淘汰「作用/用域」碎片
    for (var len = 2; len <= 3; len++) {
      for (var i = 0; i + len <= clean.length; i++) {
        var g = clean.substr(i, len);
        if (/\s/.test(g)) continue;
        freq[g] = (freq[g] || 0) + 1;
      }
    }
    Object.keys(freq).forEach(function (g) {
      if (STOPSET[g]) return;
      if (EDGESET[g[0]] || EDGESET[g[g.length - 1]]) return;
      if (freq[g] >= 2) kws.push(g); // 必须重复出现
    });
    // 去重、去被更长词包含的短词
    kws = Array.from(new Set(kws.filter(function (w) { return w && w.length >= 2; })));
    kws.sort(function (a, b) {
      var fa = freq[a] || 0, fb = freq[b] || 0;
      if (fa !== fb) return fb - fa;
      return b.length - a.length;
    });
    // 去掉被已选长词包含的
    var out = [];
    kws.forEach(function (w) {
      if (out.some(function (o) { return o.indexOf(w) >= 0 && o !== w; })) return;
      out.push(w);
    });
    return out.slice(0, limit || 5);
  }

  function makeTitle(question, keywords, insight) {
    var q = String(question || '').trim().split('\n')[0].replace(/^[•\-*]\s*/, '');
    q = q.replace(/[?？。！!]+$/, '');
    // 顿悟句（带「明白了/原来/所以」开头）不适合当标题，用理解里的关键词
    var ahaLead = /^(哦|啊|原来|明白了|懂了|所以|这样就|对对对|完全正确)/.test(q);
    if (q && !ahaLead && countHits(q, ['为什么', '怎么', '什么', '如何', '区别', '吗', '是不是']) > 0) {
      return q.length > 26 ? q.slice(0, 26) + '…' : q;
    }
    if (keywords && keywords.length >= 2) return keywords.slice(0, 2).join(' · ');
    if (insight) {
      var first = splitSentences(insight)[0] || insight;
      return first.length > 22 ? first.slice(0, 22) + '…' : first;
    }
    return q || '未命名知识点';
  }

  // 从金句里挖空造填空题
  function makeQuiz(insight, keywords) {
    var s = String(insight || '').trim();
    if (!s) return [];
    var quizzes = [];
    var kw = (keywords || []).find(function (k) { return s.indexOf(k) >= 0 && k.length >= 2; });
    if (kw) {
      var blanked = s.replace(kw, '______');
      quizzes.push({ q: '填空：' + blanked, a: kw, type: '填空' });
    }
    var first = splitSentences(s)[0];
    if (first) quizzes.push({ q: '用自己的话回答：' + first.replace(/[。！？!]$/, '') + '？', a: first, type: '简答' });
    return quizzes.slice(0, 3);
  }

  function newId() {
    return 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /* 把一段对话切成「知识块」：一条 user + 紧随的 assistant 回答 */
  function toBlocks(messages) {
    var blocks = [];
    var cur = null;
    messages.forEach(function (m) {
      if (m.role === 'user') {
        if (cur) blocks.push(cur);
        cur = { question: '', answer: '', aha: '' };
      } else if (m.role === 'assistant') {
        if (!cur) cur = { question: '', answer: '', aha: '' };
        cur.answer += (cur.answer ? '\n' : '') + m.content;
      }
      // user 的顿悟句：并入当前块的 aha
      if (cur && m.role === 'user' && countHits(m.content, AHA_WORDS) > 0) {
        cur.aha = (cur.aha ? '\n' : '') + m.content;
      } else if (cur && m.role === 'user') {
        cur.question += (cur.question ? '\n' : '') + m.content;
      }
    });
    if (cur && (cur.question || cur.answer)) blocks.push(cur);
    return blocks.filter(function (b) { return b.question.trim() || b.answer.trim(); });
  }

  function analyzeLocal(conversation) {
    var blocks = toBlocks(conversation.messages);
    var cards = blocks.map(function (b) {
      var q = b.question.trim();
      var a = stripEcho(b.answer, q).trim();
      var insight = extractInsight(a, 3);
      var keywords = extractKeywords((a + ' ' + q).slice(0, 1200), 5);
      var confuseHit = countHits(q, CONFUSE_WORDS);
      var ahaHit = countHits(b.aha, AHA_WORDS);
      return {
        id: newId(),
        sourceTitle: conversation.title,
        source: conversation.source,
        createdAt: new Date().toISOString(),
        title: makeTitle(q, keywords, insight),
        confusion: q.slice(0, 400),                 // 卡点：你的疑问原话
        insight: insight,                            // 正确理解：抽出的金句
        mnemonic: keywords.length ? ('关键词：' + keywords.join(' / ')) : '', // 助记草稿
        scene: confuseHit ? q.split('\n')[0].slice(0, 120) : '',              // 触发场景
        keywords: keywords,
        questions: makeQuiz(insight, keywords),      // 题目
        aha: b.aha.slice(0, 300),
        confidence: Math.min(5, 2 + confuseHit + (insight ? 1 : 0) + (ahaHit ? 1 : 0)),
        reviewCount: 0, lastReview: null, mastery: 0, starred: false,
        edited: false, mode: 'local'
      };
    });
    // 过滤掉几乎空白的块
    cards = cards.filter(function (c) { return c.insight || c.confusion; });
    return cards;
  }

  /* ======================= AI 增强引擎（可选） ======================= */

  var AI_PROMPT = [
    '你是一个学习助手。我会给你一段我和 AI 的对话，请分析我可能「卡在哪里」，并提炼成便于记忆的卡片。',
    '请严格输出 JSON 数组，每个元素代表一个知识卡片，字段如下：',
    '{',
    '  "title": "这个知识点的简短标题（20字内）",',
    '  "confusion": "我可能卡住的点 / 常见误区（用我的视角写，1-2句）",',
    '  "insight": "正确的理解 / 顿悟点（精炼，2-4句）",',
    '  "mnemonic": "帮我记忆的口诀、类比或一句话钩子",',
    '  "scene": "什么时候会用到或遇到这个坑（触发场景）",',
    '  "keywords": ["关键词1","关键词2"],',
    '  "questions": [{"q":"自测题","a":"答案"}]',
    '}',
    '只输出 JSON 数组，不要输出任何其他文字或解释。如果对话很短，就只输出一张卡片。',
    '对话内容如下：\n---\n'
  ].join('\n');

  function buildMessages(conversation) {
    var text = conversation.messages.map(function (m) {
      return (m.role === 'user' ? '我：' : 'AI：') + m.content;
    }).join('\n');
    return [{ role: 'user', content: AI_PROMPT + text.slice(0, 16000) + '\n---' }];
  }

  function extractJSON(text) {
    // 去掉 markdown 代码块和多余文字，抓取第一个 [...]
    var s = String(text || '').trim();
    s = s.replace(/^```(json)?\s*/i, '').replace(/```$/, '');
    var start = s.indexOf('['), end = s.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e) {}
    }
    var os = s.indexOf('{'), oe = s.lastIndexOf('}');
    if (os >= 0 && oe > os) {
      try { var o = JSON.parse(s.slice(os, oe + 1)); return Array.isArray(o) ? o : [o]; } catch (e) {}
    }
    throw new Error('AI 返回的不是有效 JSON，请重试或换用本地分析');
  }

  function aiAnalyze(conversation, settings) {
    var url = String(settings.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '') + '/chat/completions';
    var body = {
      model: settings.model || 'deepseek-chat',
      messages: buildMessages(conversation),
      temperature: 0.3,
      stream: false
    };
    if (settings.responseFormat !== false) body.response_format = { type: 'json_object' };

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + (settings.apiKey || '')
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error('API ' + res.status + '：' + t.slice(0, 200)); });
      return res.json();
    }).then(function (data) {
      var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('AI 返回为空');
      var arr = extractJSON(content);
      if (settings.responseFormat !== false && !Array.isArray(arr)) {
        arr = arr.cards || arr.items || (Array.isArray(arr.data) ? arr.data : [arr]);
      }
      return arr.map(function (x) {
        return {
          id: newId(), sourceTitle: conversation.title, source: conversation.source,
          createdAt: new Date().toISOString(),
          title: x.title || '未命名',
          confusion: x.confusion || '', insight: x.insight || '', mnemonic: x.mnemonic || '',
          scene: x.scene || '', keywords: x.keywords || [],
          questions: (x.questions || []).map(function (q) { return { q: q.q, a: q.a, type: q.type || '简答' }; }),
          aha: '', confidence: 5, reviewCount: 0, lastReview: null, mastery: 0,
          starred: false, edited: false, mode: 'ai'
        };
      }).filter(function (c) { return c.insight || c.confusion; });
    });
  }

  global.Analyzer = {
    analyzeLocal: analyzeLocal,
    aiAnalyze: aiAnalyze,
    splitSentences: splitSentences,
    extractKeywords: extractKeywords,
    PRESETS: {
      deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
      glm: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
      custom: { name: '自定义（OpenAI 兼容）', baseUrl: '', model: '' }
    }
  };
})(window);
