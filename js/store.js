/* store.js — 本地存储（localStorage）+ 备份导入导出 */
(function (global) {
  'use strict';

  var KEY = 'insight_cards_v1';
  var DEFAULT = {
    cards: [],
    conversations: [],
    settings: {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: '',
      preset: 'deepseek'
    }
  };

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return JSON.parse(JSON.stringify(DEFAULT));
      var data = JSON.parse(raw);
      return {
        cards: Array.isArray(data.cards) ? data.cards : [],
        conversations: Array.isArray(data.conversations) ? data.conversations : [],
        settings: Object.assign({}, DEFAULT.settings, data.settings || {})
      };
    } catch (e) {
      return JSON.parse(JSON.stringify(DEFAULT));
    }
  }

  function save(data) {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('保存失败', e);
      return false;
    }
  }

  function update(fn) {
    var data = load();
    var result = fn(data);
    save(data);
    return result === undefined ? data : result;
  }

  function exportBackup() {
    var data = load();
    // 导出时移除 apiKey，避免泄露
    var safe = JSON.parse(JSON.stringify(data));
    safe.settings.apiKey = '';
    safe.exportedAt = new Date().toISOString();
    safe.version = 1;
    return JSON.stringify(safe, null, 2);
  }

  function importBackup(json) {
    var data = JSON.parse(json);
    if (!data || !Array.isArray(data.cards)) throw new Error('不是有效的备份文件');
    return update(function (cur) {
      cur.cards = data.cards;
      cur.conversations = Array.isArray(data.conversations) ? data.conversations : [];
      if (data.settings) {
        cur.settings = Object.assign({}, cur.settings, data.settings, { apiKey: cur.settings.apiKey });
      }
    });
  }

  global.Store = {
    load: load, save: save, update: update,
    exportBackup: exportBackup, importBackup: importBackup,
    KEY: KEY
  };
})(window);
