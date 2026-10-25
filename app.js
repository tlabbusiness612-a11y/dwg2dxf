/* app.js - UI for the on-device DWG->DXF converter.
 * Licensed under GPL-3.0-or-later, see LICENSE.
 */
'use strict';
(function () {
  var APP_VERSION = '0.2.0';
  var $ = function (id) { return document.getElementById(id); };
  var fileEl = $('file'), goEl = $('go');
  var current = null;   // selected File
  var output = null;    // { blob, name }
  var worker = null;
  var lastMetrics = null; // measurement text for test reports (no file name, no drawing text)

  function envLines() {
    var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
    return [
      'app: v' + APP_VERSION,
      'ua: ' + navigator.userAgent,
      'mode: ' + (standalone ? 'ホーム画面アプリ' : 'ブラウザ') + ' / online=' + navigator.onLine +
        ' / sw=' + !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      'offline-badge: ' + $('offline').textContent
    ];
  }

  $('ver').textContent = 'アプリ v' + APP_VERSION;

  var VERDICT = {
    clean: ['変換完了（自動チェックで差異なし）', 'DWGから読めた要素とDXFに書かれた要素の件数・文字列は一致しました。CADでの表示確認はまだ行われていません。'],
    warnings: ['変換完了（警告あり）', 'DXFは作成されましたが、確認が必要な点があります。下の一覧を確認してください。'],
    loss: ['DXFは作成されましたが、情報が欠落している可能性があります', '欠落・未対応の要素を検出しました。このDXFをそのまま使う前に、下の一覧とCADでの表示を確認してください。'],
    failed: ['変換できませんでした', 'DXFは作成されていません。']
  };
  var LEVEL = { error: '重大', warn: '警告', info: '情報' };

  function fmtBytes(n) {
    if (n == null) return '-';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtMs(ms) { return ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' 秒'; }
  function fmtPt(p) {
    if (!p) return '-';
    return p.map(function (v) { return Number.isFinite(v) ? +v.toPrecision(10) : String(v); }).join(', ');
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  fileEl.addEventListener('change', function () {
    current = fileEl.files && fileEl.files[0] || null;
    $('result').hidden = true;
    if (!current) { $('fileinfo').textContent = '未選択'; goEl.disabled = true; return; }
    $('fileinfo').textContent = current.name + '（' + fmtBytes(current.size) + '）';
    goEl.disabled = false;
  });

  goEl.addEventListener('click', function () {
    if (!current) return;
    start(current);
  });

  async function start(file) {
    goEl.disabled = true;
    fileEl.disabled = true;
    $('result').hidden = true;
    $('status').hidden = false;
    $('stage').textContent = 'ファイルを読み込み中…';
    releaseOutput();

    var buffer;
    try {
      buffer = await file.arrayBuffer();
    } catch (e) {
      return finishError('ファイルを読み込めませんでした: ' + e.message, []);
    }
    var head = new Uint8Array(buffer, 0, Math.min(6, buffer.byteLength));
    var magic = String.fromCharCode.apply(null, head);
    if (!/^(AC1\d\d\d|AC\d\.\d\d|MC0\.0)/.test(magic)) {
      return finishError('DWGファイルではないようです（先頭: "' + magic.replace(/[^\x20-\x7e]/g, '?') + '"）', []);
    }

    if (worker) worker.terminate();
    worker = new Worker('worker.js');
    var started = performance.now();
    worker.onmessage = function (ev) {
      var m = ev.data;
      if (m.type === 'progress') $('stage').textContent = m.text;
      else if (m.type === 'done') { stopWorker(); show(file, m, performance.now() - started); }
      else if (m.type === 'error') { stopWorker(); finishError(m.message, m.log || []); }
    };
    worker.onerror = function (ev) {
      stopWorker();
      finishError('変換処理が異常終了しました: ' + (ev.message || '不明なエラー') +
        '（メモリ不足の可能性があります）', []);
    };
    worker.postMessage({ type: 'convert', name: file.name, buffer: buffer }, [buffer]);
  }

  function stopWorker() {
    // terminating the worker releases all WebAssembly memory it used
    if (worker) { worker.terminate(); worker = null; }
  }

  function releaseOutput() {
    if (output && output.url) URL.revokeObjectURL(output.url);
    output = null;
  }

  function finishError(message, log) {
    $('status').hidden = true;
    $('result').hidden = false;
    $('verdict').textContent = VERDICT.failed[0];
    $('verdict').className = 'failed';
    $('verdictNote').textContent = message;
    $('save').hidden = true;
    $('share').hidden = true;
    $('facts').replaceChildren();
    $('issues').replaceChildren();
    $('ents').tBodies[0].replaceChildren();
    $('texts').replaceChildren();
    $('log').textContent = log.join('\n');
    goEl.disabled = !current;
    fileEl.disabled = false;
    lastMetrics = envLines().concat([
      'input: ' + (current ? fmtBytes(current.size) : '-'),
      'verdict: failed',
      'error: ' + message
    ]).join('\n');
  }

  function show(file, m, wallMs) {
    $('status').hidden = true;
    $('result').hidden = false;
    goEl.disabled = false;
    fileEl.disabled = false;
    var r = m.report;
    var v = VERDICT[r.verdict] || VERDICT.failed;
    $('verdict').textContent = v[0];
    $('verdict').className = r.verdict;
    $('verdictNote').textContent = v[1];
    if (r.verdict === 'failed' && m.dxf)
      $('verdictNote').textContent = '出力されたDXFは不完全です（途中で終わっている、または図形セクションがありません）。CADで使用しないでください。';

    if (m.dxf) {
      var name = file.name.replace(/\.dwg$/i, '') + '.dxf';
      var blob = new Blob([m.dxf], { type: 'application/dxf' });
      output = { blob: blob, name: name, url: null };
      $('save').hidden = false;
      $('save').textContent = r.verdict === 'failed' ? '不完全なDXFを保存（調査用）'
        : r.verdict === 'loss' ? 'DXFを保存（欠落の可能性あり）' : 'DXFを保存';
      var shareFile = makeShareFile(blob, name);
      $('share').hidden = !shareFile;
    } else {
      $('save').hidden = true;
      $('share').hidden = true;
    }

    var facts = [
      ['元ファイル', file.name + '（' + fmtBytes(file.size) + '）'],
      ['DWGバージョン', r.dwg.version || '-'],
      ['DXFバージョン', (r.dxf.version || '-') + (r.dxf.acadver ? '（' + r.dxf.acadver + '）' : '')],
      ['DXFサイズ', m.dxf ? fmtBytes(m.dxf.byteLength) : '-'],
      ['単位 ($INSUNITS)', r.dwg.insunitsName + (r.dxf.insunits != null && r.dxf.insunits !== r.dwg.insunits ? ' → DXF: ' + r.dxf.insunits : '')],
      ['文字コード (DXF)', r.dxf.codepage || '-'],
      ['レイヤー数', r.dwg.layers + ' → ' + r.dxf.layers],
      ['ブロック定義数', r.dwg.blocks + ' → ' + r.dxf.blocks],
      ['図面範囲 (DWG $EXTMIN/MAX)', fmtPt(r.dwg.extmin) + ' 〜 ' + fmtPt(r.dwg.extmax)],
      ['座標範囲 (DXF ENTITIES 実測)', r.dxf.range ? fmtPt([r.dxf.range.minx, r.dxf.range.miny]) + ' 〜 ' + fmtPt([r.dxf.range.maxx, r.dxf.range.maxy]) : '-'],
      ['処理時間', '変換 ' + fmtMs(m.timings.convert) + ' / 照合 ' + fmtMs(m.timings.analyze) + ' / 合計 ' + fmtMs(wallMs)],
      ['WASMメモリ（変換後）', fmtBytes(m.heapBytes)],
      ['エンジン', 'LibreDWG ' + (r.libredwg || '?')]
    ];
    var dl = $('facts');
    dl.replaceChildren();
    facts.forEach(function (f) { dl.appendChild(el('dt', null, f[0])); dl.appendChild(el('dd', null, f[1])); });

    var ul = $('issues');
    ul.replaceChildren();
    if (!r.issues.length) ul.appendChild(el('li', 'info', '自動チェックでは問題を検出しませんでした。'));
    r.issues.forEach(function (i) {
      var li = el('li', i.level);
      li.appendChild(el('span', 'lvl', LEVEL[i.level] || i.level));
      li.appendChild(document.createTextNode(i.title));
      if (i.detail) li.appendChild(el('pre', null, i.detail));
      ul.appendChild(li);
    });

    var tb = $('ents').tBodies[0];
    tb.replaceChildren();
    r.entityRows.forEach(function (row) {
      var tr = el('tr', row.diff < 0 ? 'neg' : row.diff > 0 ? 'pos' : '');
      [row.type, row.dwg, row.dxf, row.diff > 0 ? '+' + row.diff : row.diff].forEach(function (c) { tr.appendChild(el('td', null, String(c))); });
      tb.appendChild(tr);
    });

    var tc = r.textCheck, box = $('texts');
    box.replaceChildren();
    box.appendChild(el('p', null, 'DWG内の文字要素 ' + tc.dwg + ' 件。属性タグを含む文字列 ' + tc.checked + ' 件（うち非ASCIIを含む ' + tc.nonAscii + ' 件）を照合し、' + tc.matched + ' 件がDXF内の文字列と完全一致。'));
    box.appendChild(el('p', 'muted', 'これは文字列データの保持の確認です。フォントが無いことによる表示の違いは、ここでは判定できません。'));
    if (tc.mismatches.length) {
      var pre = el('pre');
      pre.textContent = tc.mismatches.map(function (x) { return x.type + ': ' + x.text; }).join('\n');
      box.appendChild(el('p', null, '一致しなかった例:'));
      box.appendChild(pre);
    }
    $('log').textContent = (m.log || []).join('\n') || '(なし)';

    var ents = r.entityRows.reduce(function (a, x) { return [a[0] + x.dwg, a[1] + x.dxf]; }, [0, 0]);
    lastMetrics = envLines().concat([
      'input: ' + fmtBytes(file.size) + ' ' + (r.dwg.version || '?') + ' -> DXF ' + (r.dxf.version || '-') + ' ' + (m.dxf ? fmtBytes(m.dxf.byteLength) : '-'),
      'verdict: ' + r.verdict,
      'time: load ' + Math.round(m.timings.load) + 'ms / convert ' + Math.round(m.timings.convert) + 'ms / analyze ' +
        Math.round(m.timings.analyze) + 'ms / total(UI) ' + Math.round(wallMs) + 'ms',
      'wasm-heap: ' + fmtBytes(m.heapBytes),
      'entities: ' + ents[0] + ' -> ' + ents[1] + ' / texts ' + r.textCheck.matched + '/' + r.textCheck.checked +
        ' (non-ASCII ' + r.textCheck.nonAscii + ')',
      'issues: ' + r.issues.map(function (i) { return i.level + ':' + i.title.replace(/（.*$/, ''); }).join(' | '),
      // element type names and counts only; no drawing text
      'lost-types: ' + (r.entityRows.filter(function (x) { return x.diff < 0; })
        .map(function (x) { return x.type + ' ' + x.dwg + '→' + x.dxf; }).join(', ') || '-'),
      'text-mismatch: ' + (r.textCheck.checked - r.textCheck.matched) + '/' + r.textCheck.checked
    ]).join('\n');
  }

  $('metrics').addEventListener('click', async function () {
    if (!lastMetrics) return;
    var ta = $('metricsText');
    ta.value = lastMetrics;
    ta.hidden = false;
    try {
      await navigator.clipboard.writeText(lastMetrics);
      $('metrics').textContent = 'コピーしました';
    } catch (e) {
      // clipboard refused: leave the text selected for manual copy
      ta.focus();
      ta.select();
      $('metrics').textContent = '下の文字を選択してコピーしてください';
    }
    setTimeout(function () { $('metrics').textContent = '測定結果をコピー'; }, 2500);
  });

  function makeShareFile(blob, name) {
    if (!navigator.canShare || !window.File) return null;
    var types = ['application/dxf', 'application/octet-stream', 'text/plain'];
    for (var i = 0; i < types.length; i++) {
      try {
        var f = new File([blob], name, { type: types[i] });
        if (navigator.canShare({ files: [f] })) return f;
      } catch (e) { /* try next */ }
    }
    return null;
  }

  $('save').addEventListener('click', function () {
    if (!output) return;
    if (!output.url) output.url = URL.createObjectURL(output.blob);
    var a = document.createElement('a');
    a.href = output.url;
    a.download = output.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  $('share').addEventListener('click', async function () {
    if (!output) return;
    var f = makeShareFile(output.blob, output.name);
    if (!f) return;
    try {
      await navigator.share({ files: [f], title: output.name });
    } catch (e) {
      if (e && e.name !== 'AbortError') alert('共有できませんでした: ' + e.message);
    }
  });

  // ---- offline readiness (service worker + cache)
  async function checkOffline() {
    var badge = $('offline');
    if (!('serviceWorker' in navigator)) {
      badge.textContent = 'オフライン非対応のブラウザ／接続です（HTTPSで開く必要があります）';
      badge.className = 'badge warn';
      return;
    }
    try {
      // register only on the first visit; afterwards the app never asks the
      // server for anything until 「更新を確認」 is pressed
      if (!navigator.serviceWorker.controller) await navigator.serviceWorker.register('sw.js');
      await navigator.serviceWorker.ready;
      var info = await swMessage('info');
      var ok = info && info.ready;
      var persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      if (info && info.version) $('ver').textContent = 'アプリ v' + APP_VERSION + '（保存済みの版: ' + info.version + '）';
      if (ok) {
        badge.textContent = 'オフライン利用可能' + (persisted ? '（永続化済み）' : '（キャッシュ削除・長期間未使用で消える場合あり）');
        badge.className = 'badge ok';
      } else {
        badge.textContent = 'オフライン準備中…';
        badge.className = 'badge warn';
        setTimeout(checkOffline, 2000);
      }
    } catch (e) {
      badge.textContent = 'オフライン準備に失敗: ' + e.message;
      badge.className = 'badge warn';
    }
  }
  async function swMessage(msg, timeoutMs) {
    var reg = await navigator.serviceWorker.ready;
    return new Promise(function (resolve) {
      var ch = new MessageChannel();
      ch.port1.onmessage = function (ev) { resolve(ev.data); };
      (navigator.serviceWorker.controller || reg.active).postMessage(msg, [ch.port2]);
      setTimeout(function () { resolve(null); }, timeoutMs || 1500);
    });
  }

  // manual update: the only time the app contacts the server after install
  $('update').addEventListener('click', async function () {
    var btn = $('update'), st = $('updateStatus');
    if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
      st.textContent = 'オフライン機能が有効になっていません。';
      return;
    }
    btn.disabled = true;
    st.textContent = '最新版を確認中…（通信します）';
    var res = await swMessage('update', 120000);
    btn.disabled = false;
    if (!res) st.textContent = '応答がありません。通信状態を確認してください。';
    else if (res.error) st.textContent = '確認できませんでした（オフラインの可能性）: ' + res.error;
    else if (!res.updated) st.textContent = '最新版です（v' + res.version + '）。';
    else {
      st.textContent = 'v' + res.version + ' に更新しました。再読み込みします…';
      setTimeout(function () { location.reload(); }, 800);
    }
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  checkOffline();
})();
