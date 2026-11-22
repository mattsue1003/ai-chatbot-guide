// 用假的 Google 服務在本機跑 educator.html 裡給學員複製的「衛教小幫手」程式碼。
// 驗證的是程式邏輯；真正的 Gemini 與 LINE 連線沒辦法在這裡測。
// 執行：node test-educator.js
const fs = require('fs'), vm = require('vm'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'educator.html'), 'utf8');
const TPL = html.match(/<script type="text\/plain" id="tpl-edu">\n([\s\S]*?)<\/script>/)[1];

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } }

function makeWorld() {
  const sheets = {}, cache = {}, sent = { line: [], gemini: [] };
  function Sheet() { this.rows = []; }
  Sheet.prototype = {
    getLastRow() { return this.rows.length; },
    appendRow(r) { this.rows.push(r.slice()); },
    getRange(r, c, nr, nc) {
      const sh = this; nr = nr || 1; nc = nc || 1;
      const api = {
        getValues() { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((sh.rows[r - 1 + i] || [])[c - 1 + j] ?? ''); out.push(row); } return out; },
        setValues(v) { v.forEach((row, i) => { sh.rows[r - 1 + i] = sh.rows[r - 1 + i] || []; row.forEach((x, j) => { sh.rows[r - 1 + i][c - 1 + j] = x; }); }); return api; },
        setFontWeight() { return api; }
      };
      return api;
    },
    setFrozenRows() {}, setColumnWidth() {}
  };
  const ss = { getSheetByName: n => sheets[n] || null, insertSheet(n) { sheets[n] = new Sheet(); return sheets[n]; } };
  const resp = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });
  const gen = text => resp(200, { candidates: [{ content: { parts: [{ text }] } }] });
  const world = { sheets, cache, sent, reply: null, down: false };
  const g = {
    console, JSON, Math, Date, String, Number, Array, Object, RegExp, Error,
    Logger: { log(s) { (world.logs = world.logs || []).push(String(s)); } },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    CacheService: { getScriptCache: () => ({ get: k => (k in cache ? cache[k] : null), put(k, v) { cache[k] = v; } }) },
    HtmlService: { createHtmlOutput: s => ({ kind: 'html', content: s }) },
    UrlFetchApp: { fetch(url, opt) {
      const body = JSON.parse(opt.payload);
      if (url.includes(':generateContent')) {
        sent.gemini.push({ url, body });
        if (world.down) return resp(503, { error: { code: 503, message: 'high demand' } });
        if (opt.headers['x-goog-api-key'] !== 'TESTKEY') return resp(400, { error: { code: 400, message: 'API key not valid' } });
        const text = body.contents[0].parts[0].text;
        if (text.includes('換成繁體字')) return gen(text.split('\n\n').slice(1).join('\n\n').replace(/这/g, '這').replace(/个/g, '個').replace(/马/g, '馬').replace(/吃/g, '吃').replace(/颗/g, '顆'));
        if (!text.includes('民眾的問題：')) return gen('小糖準備好了');
        return gen(world.reply ? world.reply(text.split('民眾的問題：')[1], text) : '查無資料');
      }
      sent.line.push({ url, body, auth: opt.headers.Authorization });
      return resp(200, {});
    } }
  };
  world.g = g;
  return world;
}
function load(world, over) {
  const v = Object.assign({ KEY: 'TESTKEY', LINE: 'LINETOKEN', NAME: '小糖', ORG: '示範衛教室', TOPIC: '糖尿病' }, over || {});
  const ctx = vm.createContext(Object.assign({}, world.g));
  vm.runInContext(TPL.replace(/__(KEY|LINE|NAME|ORG|TOPIC)__/g, (m, k) => JSON.stringify(v[k])), ctx, { filename: 'educator.gs' });
  return ctx;
}
let evN = 0;
function ask(ctx, text, uid, type) {
  const ev = { type: 'message', webhookEventId: 'e' + (++evN), replyToken: 'rt' + evN, source: { type: 'user', userId: uid || 'U1' }, message: type ? { type } : { type: 'text', text } };
  return ctx.doPost({ postData: { contents: JSON.stringify({ events: [ev] }) } });
}
const last = w => { const r = w.sent.line.filter(x => x.url.endsWith('/reply')).pop(); return r ? r.body.messages[0].text : ''; };

const w = makeWorld(), c = load(w);
const SIMP = c.SIMPLIFIED;
ok(!SIMP.test(TPL), '程式碼、提示詞、示範資料裡沒有簡體字');
ok(!SIMP.test(html.replace(/<script type="text\/plain" id="tpl-edu">[\s\S]*?<\/script>/, '')), '教學頁的文字與給 AI 的指令裡沒有簡體字');

console.log('建立知識庫');
c.setupKB();
ok(w.sheets['知識庫'].rows[0].join() === '編號,主題,內容,來源名稱,來源網址' && w.sheets['知識庫'].rows.length === 9, 'setupKB 建立「知識庫」並放進 8 則示範資料');
ok(w.sheets['提問記錄'].rows[0][1] === '問題', 'setupKB 建立「提問記錄」');
ok(w.sheets['知識庫'].rows.slice(1).every(r => r[3].includes('示範資料') && r[2].length >= 60 && r[2].length <= 260), '示範資料每一則都標明是示範、內容長度合理');
c.setupKB();
ok(w.sheets['知識庫'].rows.length === 9, 'setupKB 再跑一次不會重複放資料');
ok(w.logs.some(l => l.includes('Gemini 測試：小糖準備好了')), 'setupKB 會測試金鑰');

console.log('回答與來源');
w.reply = q => q.includes('低血糖') ? '・**馬上**吃 15 公克的糖 [2]\n・15 分鐘後再量 [2]\n・症狀有冒冷汗 [1]' : q.includes('亂標') ? '多喝水就好 [99]' : q.includes('沒標') ? '多運動就會好' : '查無資料';
w.sheets['知識庫'].rows[2][4] = 'https://example.org/hypo';
const out = ask(c, '低血糖的時候要怎麼辦？');
let r = last(w);
ok(out.kind === 'html', 'doPost 回傳 HtmlService');
ok(r.includes('馬上吃 15 公克的糖 [2]') && !r.includes('**'), '回答保留 [編號]，並去掉 Markdown 粗體');
ok(r.includes('資料來源：\n[2] 示範資料（請換成貴單位的衛教單張名稱）\nhttps://example.org/hypo\n[1] 示範資料'), '來源名稱與網址由程式從知識庫帶出，依出現順序、不重複');
ok(r.endsWith(c.DISCLAIMER), '每則回答最後有提醒文字');
const call = w.sent.gemini[w.sent.gemini.length - 1].body;
const sys = call.system_instruction.parts[0].text;
ok(sys.includes('只能根據下面提供的「衛教資料」回答') && sys.includes('查無資料') && sys.includes('不可以建議開始、停止或調整任何藥物與劑量') && sys.includes('示範衛教室') && sys.includes('小糖'), '系統指示：只根據資料、找不到就說查無資料、不調藥，並帶入單位與名字');
ok(sys.includes('一律使用繁體中文（台灣用語）'), '系統指示要求繁體中文');
ok(call.contents[0].parts[0].text.includes('[2]（低血糖的處理）') && call.contents[0].parts[0].text.includes('民眾的問題：低血糖的時候要怎麼辦？'), '把知識庫內容和問題一起送給 Gemini');
ok(w.sent.line.some(x => x.url.endsWith('/chat/loading/start')) && w.sent.line[0].auth === 'Bearer LINETOKEN', '送出輸入中動畫，LINE 請求帶權杖');
let log = w.sheets['提問記錄'].rows;
ok(log.length === 2 && log[1][1] === '低血糖的時候要怎麼辦？' && log[1][3] === '2、1' && !JSON.stringify(log).includes('U1'), '提問記錄：記問題、回答、用到的編號，不記是誰問的');

console.log('不亂答');
ask(c, '颱風天要準備什麼？');
ok(last(w) === c.NOT_FOUND, '知識庫沒有的問題：回「找不到」');
ask(c, '亂標來源的問題');
ok(last(w) === c.NOT_FOUND, 'AI 標了知識庫沒有的編號：整則不送出');
ask(c, '沒標來源的問題');
ok(last(w) === c.NOT_FOUND && !last(w).includes('多運動'), 'AI 沒有標出處：整則不送出');
w.sheets['知識庫'].rows.push([9, '沒有來源的內容', '這一列沒有填來源名稱，不應該被拿來回答。', '', '']);
ok(c.readKB().length === 8, '沒填來源名稱的那一列不會被使用');
w.sheets['知識庫'].rows.pop();

console.log('緊急、打招呼、其他');
let g0 = w.sent.gemini.length;
ask(c, '我爸爸叫不醒怎麼辦');
ok(last(w) === c.EMERGENCY_REPLY && last(w).includes('119') && w.sent.gemini.length === g0, '緊急關鍵字：直接回就醫提醒，不問 AI');
ask(c, '你好');
ok(last(w).includes('小糖') && last(w).includes('示範衛教室') && last(w).includes('低血糖的處理') && last(w).includes('個人資料') && w.sent.gemini.length === g0, '打招呼：自我介紹、列出主題、提醒不要傳個資，不問 AI');
ask(c, '', 'U1', 'image');
ok(last(w).includes('只看得懂文字'), '非文字訊息：說明只看得懂文字');
const dup = { type: 'message', webhookEventId: 'same', replyToken: 'x', source: { type: 'user', userId: 'U1' }, message: { type: 'text', text: '低血糖' } };
let n0 = w.sent.line.filter(x => x.url.endsWith('/reply')).length;
c.doPost({ postData: { contents: JSON.stringify({ events: [dup] }) } });
c.doPost({ postData: { contents: JSON.stringify({ events: [dup] }) } });
ok(w.sent.line.filter(x => x.url.endsWith('/reply')).length === n0 + 1, 'LINE 重送同一則訊息只回一次');
for (let i = 0; i < 25; i++) ask(c, '低血糖 ' + i, 'U-busy');
ok(last(w).includes('問的問題比較多'), '同一個人一小時問超過上限會被請稍後再問');
ask(c, '低血糖', 'U-other');
ok(last(w).includes('資料來源'), '其他人不受影響');
w.down = true;
ask(c, '低血糖怎麼辦', 'U3');
ok(last(w).includes('系統暫時有狀況') && last(w).includes('太多人使用'), 'Gemini 忙線時回一句說明，不會沒反應');
ok(w.sent.gemini.slice(-3).map(x => x.url.match(/models\/([^:]+)/)[1]).join() === 'gemini-3.5-flash-lite,gemini-3.6-flash,gemini-3.8-flash', '忙線時依序換備用模型');
w.down = false;

console.log('繁體中文');
w.reply = () => '这个时候马上吃 3 颗方糖 [2]';
ask(c, '低血糖要吃什麼', 'U4');
ok(last(w).includes('這個') && last(w).includes('馬上吃 3 顆方糖 [2]') && last(w).includes('https://example.org/hypo'), 'AI 回簡體時轉成繁體，來源網址不受影響');

console.log('挑資料');
const kb = []; for (let i = 1; i <= 30; i++) kb.push({ id: String(i), topic: i === 17 ? '足部照護' : '主題' + i, text: i === 17 ? '每天檢查雙腳和趾縫' : '無關的內容' + i, source: 's', url: '' });
const picks = c.pickRows('腳要怎麼照護', kb, 8);
ok(picks.length === 8 && picks[0].id === '17', '知識庫很大時，只挑最相關的 8 則，相關的排最前面');
ok(c.pickRows('x', kb.slice(0, 5), 8).length === 5, '知識庫很小時全部送出');

console.log('自由調整');
const w2 = makeWorld(), c2 = load(w2, { NAME: "阿'糖", ORG: '高血壓門診', TOPIC: '高血壓' });
c2.setupKB();
vm.runInContext("EMERGENCY_WORDS.push('頭很痛'); NOT_FOUND = '請撥衛教專線'; DISCLAIMER = '有問題請回診'; LOG_QUESTIONS = false;", c2);
w2.reply = () => '少鹽 [4]';
ask(c2, '你好');
ok(last(w2).includes("高血壓門診的高血壓衛教小幫手「阿'糖」"), '名字、單位、主題可以改（名字裡有單引號也不會壞）');
ask(c2, '要吃什麼');
ok(last(w2).endsWith('有問題請回診') && w2.sent.gemini.pop().body.system_instruction.parts[0].text.includes('高血壓衛教小幫手'), '提醒文字與主題改了之後，回答和系統指示都跟著變');
ask(c2, '我頭很痛');
ok(last(w2) === c2.EMERGENCY_REPLY, '可以自己加緊急關鍵字');
w2.reply = () => '查無資料';
ask(c2, '颱風');
ok(last(w2) === '請撥衛教專線' && w2.sheets['提問記錄'].rows.length === 1, '找不到時的回覆可以改；關掉記錄後不會寫入');
const w3 = makeWorld(), c3 = load(w3, { KEY: 'WRONG' });
c3.setupKB = c3.setupKB; w3.sheets['知識庫'] = w.sheets['知識庫'];
ask(c3, '低血糖');
ok(last(w3).includes('金鑰好像不對') && w3.sent.gemini.length === 1, '金鑰錯誤：說明原因，不會白白換模型重試');

console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
