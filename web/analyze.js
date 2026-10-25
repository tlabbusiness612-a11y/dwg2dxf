/* analyze.js - re-reads the produced DXF and compares it with what LibreDWG
 * decoded from the DWG (the JSON summary written by w_convert).
 *
 * Used by worker.js (browser) and tools/convert-node.mjs (Node). Plain
 * script so it can be loaded with importScripts() in a classic worker.
 * Licensed under GPL-3.0-or-later, see LICENSE.
 */
(function (root) {
  'use strict';

  // $DWGCODEPAGE -> TextDecoder label (only for pre-R2007 DXF, which is not UTF-8)
  var CODEPAGES = {
    ANSI_932: 'shift_jis', DOS932: 'shift_jis',
    ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
    ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252',
    ANSI_1253: 'windows-1253', ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255',
    ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257', ANSI_1258: 'windows-1258',
    ANSI_874: 'windows-874'
  };

  var ACADVER = {
    AC1009: 'R12', AC1012: 'R13', AC1014: 'R14', AC1015: 'R2000', AC1018: 'R2004',
    AC1021: 'R2007', AC1024: 'R2010', AC1027: 'R2013', AC1032: 'R2018'
  };

  var INSUNITS = ['単位なし', 'インチ', 'フィート', 'マイル', 'ミリメートル', 'センチメートル',
    'メートル', 'キロメートル', 'マイクロインチ', 'ミル', 'ヤード', 'オングストローム',
    'ナノメートル', 'ミクロン', 'デシメートル', 'デカメートル', 'ヘクトメートル',
    'ギガメートル', '天文単位', '光年', 'パーセク'];

  // LibreDWG error bits (include/dwg.h)
  var ERRBITS = [
    [1, 'WRONGCRC', 'CRC不一致（一部データの検査値が不正）'],
    [2, 'NOTYETSUPPORTED', '未対応の機能・バージョンを含む（一部がスキップされた可能性）'],
    [4, 'UNHANDLEDCLASS', '未対応のクラスを含む（該当要素はDXFに出力されない）'],
    [8, 'INVALIDTYPE', '不正な型の要素を検出'],
    [16, 'INVALIDHANDLE', '不正なハンドル参照を検出（関連付けが切れている可能性）'],
    [32, 'INVALIDEED', '不正な拡張データ(EED)を検出（無視された可能性）'],
    [64, 'VALUEOUTOFBOUNDS', '範囲外の値を検出'],
    [128, 'CLASSESNOTFOUND', 'クラスセクションが見つからない'],
    [256, 'SECTIONNOTFOUND', '必須セクションが見つからない'],
    [512, 'PAGENOTFOUND', 'データページが見つからない'],
    [1024, 'INTERNALERROR', '内部エラー'],
    [2048, 'INVALIDDWG', 'DWGファイルとして不正、または破損'],
    [4096, 'IOERROR', '入出力エラー'],
    [8192, 'OUTOFMEM', 'メモリ不足']
  ];
  var CRITICAL = 128;

  function decodeErrors(code) {
    var out = [];
    for (var i = 0; i < ERRBITS.length; i++)
      if (code & ERRBITS[i][0]) out.push({ bit: ERRBITS[i][0], id: ERRBITS[i][1], text: ERRBITS[i][2] });
    return out;
  }

  function makeDecoder(label) {
    try { return new TextDecoder(label); } catch (e) { return new TextDecoder('utf-8'); }
  }

  /* Byte-level tokenizer: yields [groupCode, valueStart, valueEnd] without
     decoding the whole file into a JS string. */
  function forEachPair(bytes, cb) {
    var n = bytes.length, pos = 0;
    // skip UTF-8 BOM
    if (n >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) pos = 3;
    while (pos < n) {
      var e1 = bytes.indexOf(10, pos);
      if (e1 < 0) e1 = n;
      var code = 0, neg = false, any = false;
      for (var i = pos; i < e1; i++) {
        var c = bytes[i];
        if (c >= 48 && c <= 57) { code = code * 10 + (c - 48); any = true; }
        else if (c === 45) neg = true;
      }
      if (!any) { pos = e1 + 1; continue; }
      var vs = e1 + 1;
      var e2 = bytes.indexOf(10, vs);
      if (e2 < 0) e2 = n;
      var ve = e2;
      if (ve > vs && bytes[ve - 1] === 13) ve--;
      if (cb(neg ? -code : code, vs, ve) === false) return;
      pos = e2 + 1;
    }
  }

  function ascii(bytes, s, e) {
    var str = '';
    for (var i = s; i < e; i++) str += String.fromCharCode(bytes[i]);
    return str.trim();
  }

  // Normalise text for comparison: decode \U+XXXX escapes LibreDWG emits for
  // characters outside the DXF code page.
  function normText(s) {
    if (s == null) return '';
    return String(s).replace(/\\U\+([0-9A-Fa-f]{4})/g, function (_, h) {
      return String.fromCharCode(parseInt(h, 16));
    });
  }

  function hasNonAscii(s) { return /[^\x00-\x7f]/.test(s); }

  function parseDxf(bytes) {
    var r = {
      acadver: null, codepage: null, insunits: null, extmin: null, extmax: null,
      sections: {}, entities: {}, blockEntities: {}, objects: {}, tables: {},
      texts: [], range: null, numBlocks: 0, eofSeen: false
    };
    var utf8 = makeDecoder('utf-8');
    var textDecoder = utf8; // switched after HEADER if pre-R2007
    var section = null, rec = null, headerVar = null, tableName = null;
    var cur = null; // current entity text collector
    var range = { minx: Infinity, miny: Infinity, minz: Infinity, maxx: -Infinity, maxy: -Infinity, maxz: -Infinity, n: 0 };
    var pendingX = null, pendingY = null;
    var expectSectionName = false;
    // handle bookkeeping for dangling-reference detection
    var defined = {}, dictRefs = [], ownerRefs = [], ownerSeen = false;

    function flushText() {
      if (!cur) return;
      var t = cur.type === 'MTEXT' ? (cur.parts.join('') + (cur.last != null ? cur.last : '')) : cur.last;
      // DXF writes control characters as caret escapes (^J newline, ^M CR, ^I tab)
      if (t != null) r.texts.push([cur.type, t.replace(/\^([JMI])/g, function (_, c) {
        return c === 'J' ? '\n' : c === 'M' ? '\r' : '\t';
      })]);
      if (cur.tag != null) r.texts.push([cur.type + '_TAG', cur.tag]);
      cur = null;
    }
    function decodeVal(s, e) {
      return textDecoder.decode(bytes.subarray(s, e));
    }
    function addPoint(x, y, z) {
      if (!isFinite(x) || !isFinite(y)) return;
      range.minx = Math.min(range.minx, x); range.maxx = Math.max(range.maxx, x);
      range.miny = Math.min(range.miny, y); range.maxy = Math.max(range.maxy, y);
      if (z !== null && isFinite(z)) { range.minz = Math.min(range.minz, z); range.maxz = Math.max(range.maxz, z); }
      range.n++;
    }

    forEachPair(bytes, function (code, s, e) {
      if (code === 0) {
        flushText();
        var v = ascii(bytes, s, e);
        rec = v;
        ownerSeen = false;
        if (v === 'SECTION') { expectSectionName = true; return; }
        if (v === 'ENDSEC') {
          if (section === 'HEADER') {
            var ver = r.acadver;
            var newer = ver && ver >= 'AC1021';
            if (!newer && r.codepage && CODEPAGES[r.codepage]) textDecoder = makeDecoder(CODEPAGES[r.codepage]);
          }
          section = null; return;
        }
        if (v === 'EOF') { r.eofSeen = true; return false; }
        if (section === 'ENTITIES' || section === 'BLOCKS') {
          if (v === 'BLOCK') { r.numBlocks++; }
          var bucket = section === 'ENTITIES' ? r.entities : r.blockEntities;
          bucket[v] = (bucket[v] || 0) + 1;
          if (v === 'TEXT' || v === 'MTEXT' || v === 'ATTRIB' || v === 'ATTDEF' || v === 'TOLERANCE')
            cur = { type: v, parts: [], last: null };
        } else if (section === 'OBJECTS') {
          r.objects[v] = (r.objects[v] || 0) + 1;
        } else if (section === 'TABLES') {
          if (v !== 'TABLE' && v !== 'ENDTAB') r.tables[v] = (r.tables[v] || 0) + 1;
        }
        return;
      }
      if (expectSectionName && code === 2) {
        section = ascii(bytes, s, e); expectSectionName = false;
        r.sections[section] = true; return;
      }
      if (section && section !== 'HEADER') {
        if (code === 5 || (code === 105 && rec === 'DIMSTYLE')) defined[ascii(bytes, s, e).toUpperCase()] = 1;
        else if (section === 'OBJECTS') {
          if ((code === 350 || code === 360) && rec === 'DICTIONARY') dictRefs.push(ascii(bytes, s, e).toUpperCase());
          else if (code === 330 && !ownerSeen) { ownerSeen = true; ownerRefs.push([rec, ascii(bytes, s, e).toUpperCase()]); }
        }
      }
      if (section === 'HEADER') {
        if (code === 9) { headerVar = ascii(bytes, s, e); return; }
        if (headerVar === '$ACADVER' && code === 1) r.acadver = ascii(bytes, s, e);
        else if (headerVar === '$DWGCODEPAGE' && code === 3) r.codepage = ascii(bytes, s, e);
        else if (headerVar === '$INSUNITS' && code === 70) r.insunits = parseInt(ascii(bytes, s, e), 10);
        else if (headerVar === '$EXTMIN' || headerVar === '$EXTMAX') {
          var key = headerVar === '$EXTMIN' ? 'extmin' : 'extmax';
          if (!r[key]) r[key] = [0, 0, 0];
          if (code === 10) r[key][0] = parseFloat(ascii(bytes, s, e));
          if (code === 20) r[key][1] = parseFloat(ascii(bytes, s, e));
          if (code === 30) r[key][2] = parseFloat(ascii(bytes, s, e));
        }
        return;
      }
      if (section === 'ENTITIES' || section === 'BLOCKS') {
        if (cur) {
          if (code === 1) cur.last = decodeVal(s, e);
          else if (code === 3 && cur.type === 'MTEXT') cur.parts.push(decodeVal(s, e));
          else if (code === 2 && (cur.type === 'ATTRIB' || cur.type === 'ATTDEF') && cur.tag == null) cur.tag = decodeVal(s, e);
        }
        if (section === 'ENTITIES') {
          // primary points (10/20[/30]); 2D points such as LWPOLYLINE vertices have no 30
          if (code === 20 && pendingX !== null) pendingY = parseFloat(ascii(bytes, s, e));
          else if (code === 30 && pendingY !== null) {
            addPoint(pendingX, pendingY, parseFloat(ascii(bytes, s, e)));
            pendingX = pendingY = null;
          } else {
            if (pendingY !== null) addPoint(pendingX, pendingY, null);
            pendingX = pendingY = null;
            if (code === 10) pendingX = parseFloat(ascii(bytes, s, e));
          }
        }
      }
    });
    flushText();
    if (range.n) r.range = range;
    r.danglingDictRefs = dictRefs.filter(function (h) { return h !== '0' && !defined[h]; }).length;
    r.danglingOwners = {};
    ownerRefs.forEach(function (o) {
      if (o[1] !== '0' && !defined[o[1]]) r.danglingOwners[o[0]] = (r.danglingOwners[o[0]] || 0) + 1;
    });
    r.version = ACADVER[r.acadver] || r.acadver;
    return r;
  }

  // LibreDWG's internal entity names -> the record name written to DXF
  function dxfRecordName(name) {
    if (/^DIMENSION_/.test(name)) return 'DIMENSION';
    if (/^POLYLINE_/.test(name)) return 'POLYLINE';
    if (/^VERTEX_/.test(name)) return 'VERTEX';
    return name;
  }

  // table entries live in the DXF TABLES section under these names
  var TABLE_ENTRY = {
    LAYER: 'LAYER', LTYPE: 'LTYPE', STYLE: 'STYLE', DIMSTYLE: 'DIMSTYLE', APPID: 'APPID',
    VPORT: 'VPORT', VIEW: 'VIEW', UCS: 'UCS', BLOCK_HEADER: 'BLOCK_RECORD'
  };

  // what a missing non-graphical object means for the user
  var OBJECT_NOTES = {
    MATERIAL: 'マテリアル定義', TABLESTYLE: '表スタイル', MLEADERSTYLE: 'マルチ引出線スタイル',
    DIMASSOC: '寸法の関連付け（寸法自体は残るが、図形との連動が失われる）',
    ACAD_EVALUATION_GRAPH: 'ダイナミックブロックの評価グラフ', GEODATA: '地理座標データ',
    ACAD_TABLE: '表', FIELD: 'フィールド', FIELDLIST: 'フィールド一覧', SORTENTSTABLE: '表示順',
    GROUP: 'グループ', IMAGEDEF: '画像定義', RASTERVARIABLES: '画像変数', LAYER_FILTER: 'レイヤーフィルタ',
    LAYER_INDEX: 'レイヤーインデックス', SPATIAL_FILTER: 'クリップ境界', SPATIAL_INDEX: '空間インデックス',
    PLOTSETTINGS: '印刷設定', LAYOUT: 'レイアウト', CELLSTYLEMAP: 'セルスタイル', SCALE: '注釈尺度'
  };

  function addCounts(a, b) {
    var o = {}, k;
    for (k in a) o[k] = (o[k] || 0) + a[k];
    for (k in b) o[k] = (o[k] || 0) + b[k];
    return o;
  }

  /* Compare DWG summary vs parsed DXF and build the report shown to the user. */
  function compare(summary, dxf, logLines) {
    var issues = [];   // {level: 'error'|'warn'|'info', title, detail}
    var errs = decodeErrors(summary.read_error | 0);
    var werrs = decodeErrors(summary.write_error | 0);

    errs.forEach(function (e) {
      var lvl = e.bit >= CRITICAL ? 'error' : (e.bit === 4 || e.bit === 2 || e.bit === 8 ? 'warn' : 'warn');
      issues.push({ level: lvl, title: 'DWG読込: ' + e.text, detail: 'LibreDWG ' + e.id });
    });
    werrs.forEach(function (e) {
      var lvl = e.bit >= CRITICAL ? 'error' : 'warn';
      issues.push({ level: lvl, title: 'DXF書出: ' + e.text, detail: 'LibreDWG ' + e.id });
    });

    // ---- entity counts by DXF type name
    var dwgEnt = {}, dwgObj = {}, unsupported = [], unstable = [];
    (summary.types || []).forEach(function (t) {
      var key = t.dxfname || t.name;
      if (t.entity) key = dxfRecordName(key);
      if (t.entity) dwgEnt[key] = (dwgEnt[key] || 0) + t.count;
      else dwgObj[key] = (dwgObj[key] || 0) + t.count;
      if (t.status === 'unknown' || t.status === 'unhandled' || t.status === 'debugging')
        unsupported.push(t);
      else if (t.status === 'unstable') unstable.push(t);
    });
    var dxfEnt = addCounts(dxf.entities, dxf.blockEntities);
    var rows = [], missingTotal = 0, k;
    var keys = {};
    for (k in dwgEnt) keys[k] = 1;
    for (k in dxfEnt) keys[k] = 1;
    Object.keys(keys).sort().forEach(function (key) {
      var a = dwgEnt[key] || 0, b = dxfEnt[key] || 0;
      rows.push({ type: key, dwg: a, dxf: b, diff: b - a });
      if (b < a) missingTotal += a - b;
    });
    var lost = rows.filter(function (r) { return r.diff < 0; });
    if (lost.length)
      issues.push({
        level: 'error',
        title: '図形数の不一致: DXFに出力されていない図形が ' + missingTotal + ' 個あります',
        detail: lost.map(function (r) { return r.type + ' ' + r.dwg + '→' + r.dxf; }).join(', ')
      });
    var gained = rows.filter(function (r) { return r.diff > 0; });
    if (gained.length)
      issues.push({
        level: 'warn',
        title: 'DXF側で数が増えた図形タイプがあります（分解・変換の可能性）',
        detail: gained.map(function (r) { return r.type + ' ' + r.dwg + '→' + r.dxf; }).join(', ')
      });

    if (unsupported.length)
      issues.push({
        level: 'error',
        title: 'LibreDWGが未対応の要素を含みます（DXFには出力されません）',
        detail: unsupported.map(function (t) { return (t.dxfname || t.name) + ' ×' + t.count + ' [' + t.status + ']'; }).join(', ')
      });
    if (unstable.length)
      issues.push({
        level: 'warn',
        title: 'LibreDWGで「不安定」扱いの要素を含みます（内容が不完全な可能性）',
        detail: unstable.map(function (t) { return (t.dxfname || t.name) + ' ×' + t.count; }).join(', ')
      });

    var proxies = (dwgEnt.ACAD_PROXY_ENTITY || 0) + (dwgObj.ACAD_PROXY_OBJECT || 0);
    if (proxies)
      issues.push({ level: 'warn', title: 'プロキシ要素が ' + proxies + ' 個あります', detail: '作成元アプリ固有のデータ。DXFでは代替表示のみ・再現されない場合があります。' });
    if (dwgEnt.MLINE)
      issues.push({ level: 'warn', title: 'MLINE（マルチライン）を含みます', detail: 'LibreDWGのソースに「AutoCADでの読込に問題がある」旨の注記があります。AutoCADでの確認が必要です。' });
    if (dwgEnt.OLE2FRAME)
      issues.push({ level: 'warn', title: 'OLEオブジェクトを含みます', detail: '埋め込みOLEの再現性は未検証です。' });

    // ---- tables
    var dwgLayers = (summary.layers || []).length;
    var dxfLayers = dxf.tables.LAYER || 0;
    if (dwgLayers !== dxfLayers)
      issues.push({ level: 'warn', title: 'レイヤー数の不一致', detail: 'DWG ' + dwgLayers + ' / DXF ' + dxfLayers });
    var tableLost = [];
    Object.keys(TABLE_ENTRY).forEach(function (t) {
      if (t === 'LAYER') return;
      var a = dwgObj[t] || 0, b = dxf.tables[TABLE_ENTRY[t]] || 0;
      if (b < a) tableLost.push(TABLE_ENTRY[t] + ' ' + a + '→' + b);
    });
    if (tableLost.length)
      issues.push({ level: 'warn', title: 'テーブル（線種・文字スタイル・寸法スタイル等）の件数が減っています', detail: tableLost.join(', ') });

    // ---- non-graphical objects (styles, associativity, dictionaries ...)
    var objLost = [];
    Object.keys(dwgObj).sort().forEach(function (t) {
      if (/_CONTROL$/.test(t) || TABLE_ENTRY[t] || t === 'UNKNOWN_OBJ') return;
      var a = dwgObj[t], b = dxf.objects[t] || 0;
      if (b < a) objLost.push(t + ' ' + a + '→' + b + (OBJECT_NOTES[t] ? '（' + OBJECT_NOTES[t] + '）' : ''));
    });
    if (objLost.length)
      issues.push({
        level: 'warn',
        title: '図形以外の定義データの一部がDXFに出力されていません（' + objLost.length + ' 種類）',
        detail: objLost.join('\n')
      });

    // ---- references to objects that were not written
    var dOwn = dxf.danglingOwners || {}, dOwnN = 0;
    for (k in dOwn) dOwnN += dOwn[k];
    if (dxf.danglingDictRefs || dOwnN)
      issues.push({
        level: 'warn',
        title: 'DXF内に参照先が存在しない参照があります（辞書 ' + (dxf.danglingDictRefs | 0) + ' 件、所有者 ' + dOwnN + ' 件）',
        detail: '出力されなかったオブジェクトへの参照が残っています。CADによっては読込時に修復・警告が出る可能性があります。' +
          (dOwnN ? '\n所有者不明: ' + Object.keys(dOwn).map(function (t) { return t + ' ×' + dOwn[t]; }).join(', ') : '')
      });

    // ---- external references (cannot be resolved from the DWG alone)
    var xrefs = (summary.blocks || []).filter(function (b) { return b.xref || b.overlay; });
    if (xrefs.length)
      issues.push({
        level: 'info',
        title: '外部参照が ' + xrefs.length + ' 件あります（参照先ファイルは元DWGに含まれません）',
        detail: xrefs.map(function (b) { return b.name + (b.path ? ' → ' + b.path : ''); }).join('\n')
      });
    var images = (summary.images || []).filter(function (x) { return x; });
    if (images.length)
      issues.push({ level: 'info', title: 'ラスター画像の参照が ' + images.length + ' 件あります（画像ファイルは含まれません）', detail: images.join('\n') });

    // ---- texts
    var textCheck = { dwg: summary.texts_total | 0, dxf: dxf.texts.length, matched: 0, nonAscii: 0, mismatches: [], checked: 0 };
    var pool = {};
    dxf.texts.forEach(function (t) {
      var key = t[0] + '\u0000' + normText(t[1]);
      pool[key] = (pool[key] || 0) + 1;
    });
    (summary.texts || []).forEach(function (t) {
      var s = t[1];
      if (s == null) return;
      textCheck.checked++;
      if (hasNonAscii(s)) textCheck.nonAscii++;
      var key = t[0] + '\u0000' + normText(s);
      if (pool[key]) { pool[key]--; textCheck.matched++; }
      else if (textCheck.mismatches.length < 30) textCheck.mismatches.push({ type: t[0], text: s });
    });
    var textMiss = textCheck.checked - textCheck.matched;
    if (textMiss > 0)
      issues.push({
        level: 'error',
        title: '文字列の不一致: ' + textMiss + ' / ' + textCheck.checked + ' 件がDXF内で同一文字列として見つかりません',
        detail: textCheck.mismatches.slice(0, 10).map(function (m) { return m.type + ': ' + m.text; }).join('\n')
      });
    if ((summary.texts_total | 0) > (summary.texts || []).length)
      issues.push({ level: 'info', title: '文字列照合は先頭 ' + (summary.texts || []).length + ' 件のみ実施', detail: '全 ' + summary.texts_total + ' 件' });
    var unreadable = (summary.texts || []).length - textCheck.checked;
    if (unreadable > 0)
      issues.push({ level: 'warn', title: 'DWG側で読み取れなかった文字列が ' + unreadable + ' 件あります', detail: '' });

    // ---- structure sanity
    if (!dxf.eofSeen) issues.push({ level: 'error', title: 'DXFが途中で終わっています（EOFなし）', detail: '' });
    ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES'].forEach(function (s) {
      if (!dxf.sections[s]) issues.push({ level: 'error', title: 'DXFに ' + s + ' セクションがありません', detail: '' });
    });

    // ---- LibreDWG log
    var logErrors = (logLines || []).filter(function (l) { return /ERROR/.test(l); });
    var logWarns = (logLines || []).filter(function (l) { return /Warning|WARN/i.test(l) && !/ERROR/.test(l); });
    if (logErrors.length)
      issues.push({ level: 'warn', title: 'LibreDWGのログにエラー行が ' + logErrors.length + ' 件あります', detail: uniq(logErrors).slice(0, 15).join('\n') });
    if (logWarns.length)
      issues.push({ level: 'info', title: 'LibreDWGのログに警告行が ' + logWarns.length + ' 件あります', detail: uniq(logWarns).slice(0, 15).join('\n') });

    var level = 'ok';
    issues.forEach(function (i) {
      if (i.level === 'error') level = 'error';
      else if (i.level === 'warn' && level !== 'error') level = 'warn';
    });
    // a DXF without EOF or ENTITIES is unusable even if LibreDWG reported no critical error
    var incomplete = !dxf.eofSeen || !dxf.sections.ENTITIES;
    var critical = incomplete || (summary.read_error | 0) >= CRITICAL || (summary.write_error | 0) >= CRITICAL;

    return {
      verdict: critical ? 'failed' : level === 'error' ? 'loss' : level === 'warn' ? 'warnings' : 'clean',
      issues: issues,
      entityRows: rows,
      objectCounts: { dwg: dwgObj, dxf: dxf.objects },
      textCheck: textCheck,
      dwg: {
        version: summary.dwg_version, codepage: summary.codepage, objects: summary.num_objects,
        insunits: summary.header && summary.header.INSUNITS,
        insunitsName: summary.header ? (INSUNITS[summary.header.INSUNITS] || String(summary.header.INSUNITS)) : '',
        measurement: summary.header && summary.header.MEASUREMENT,
        extmin: summary.header && summary.header.EXTMIN, extmax: summary.header && summary.header.EXTMAX,
        layers: dwgLayers, blocks: (summary.blocks || []).length
      },
      dxf: {
        version: dxf.version, acadver: dxf.acadver, codepage: dxf.codepage,
        insunits: dxf.insunits, extmin: dxf.extmin, extmax: dxf.extmax, range: dxf.range,
        layers: dxfLayers, blocks: dxf.numBlocks
      },
      libredwg: summary.libredwg
    };
  }

  function uniq(a) {
    var seen = {}, o = [];
    a.forEach(function (x) { if (!seen[x]) { seen[x] = 1; o.push(x); } });
    return o;
  }

  var api = { parseDxf: parseDxf, compare: compare, decodeErrors: decodeErrors, INSUNITS: INSUNITS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DxfAnalyze = api;
})(typeof self !== 'undefined' ? self : this);
