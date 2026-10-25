/* worker.js - runs one DWG->DXF conversion off the main thread.
 *
 * The page creates a fresh worker per conversion and terminates it when
 * done: WebAssembly memory can grow but never shrink, so throwing the whole
 * worker away is the reliable way to give the memory back (important on
 * iPhone/iPad). Nothing here touches the network; the drawing only lives in
 * this worker's memory and in the in-memory filesystem of the engine.
 * Licensed under GPL-3.0-or-later, see LICENSE.
 */
'use strict';
importScripts('engine/dwg2dxf.js', 'analyze.js');

var log = [];
var MAX_LOG = 5000;
function pushLog(line) {
  if (log.length < MAX_LOG) log.push(String(line));
  else if (log.length === MAX_LOG) log.push('... (ログが多いため以降を省略)');
}

function post(type, data, transfer) {
  data = data || {};
  data.type = type;
  self.postMessage(data, transfer || []);
}

function now() { return (self.performance && performance.now) ? performance.now() : Date.now(); }

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.type !== 'convert') return;
  convert(msg).catch(function (err) {
    post('error', { message: (err && err.message) || String(err), log: log });
  });
};

async function convert(msg) {
  var t0 = now();
  post('progress', { stage: 'load', text: '変換エンジンを準備中（端末内のコピーを使用・通信なし）…' });
  var mod = await createDwg2Dxf({
    print: pushLog,
    printErr: pushLog,
    locateFile: function (p) { return 'engine/' + p; }
  });
  var tLoad = now() - t0;

  var input = new Uint8Array(msg.buffer);
  var inPath = '/in.dwg', outPath = '/out.dxf', sumPath = '/summary.json';
  mod.FS.writeFile(inPath, input);
  // release our reference to the input copy; the engine keeps its own
  input = null;
  msg.buffer = null;

  post('progress', { stage: 'convert', text: 'DWGを読み込み、DXFへ変換中…' });
  var t1 = now();
  var code = mod.ccall('w_convert', 'number',
    ['string', 'string', 'string', 'string', 'number'],
    [inPath, outPath, sumPath, msg.asVersion || '', msg.loglevel == null ? 1 : msg.loglevel]);
  var tConvert = now() - t1;
  var heapBytes = mod.HEAPU8 ? mod.HEAPU8.buffer.byteLength : 0;

  try { mod.FS.unlink(inPath); } catch (e) { /* ignore */ }

  var summary = null;
  try {
    summary = JSON.parse(mod.FS.readFile(sumPath, { encoding: 'utf8' }));
  } catch (e) {
    pushLog('summary.json を読めません: ' + e.message);
  }

  var dxf = null;
  try { dxf = mod.FS.readFile(outPath); } catch (e) { /* no output */ }
  try { mod.FS.unlink(outPath); } catch (e) { /* ignore */ }
  try { mod.FS.unlink(sumPath); } catch (e) { /* ignore */ }

  if (!summary) {
    post('error', { message: '変換エンジンが結果を返しませんでした (code ' + code + ')', log: log });
    return;
  }

  var report = null, tAnalyze = 0;
  if (dxf && dxf.length && code < 128) {
    post('progress', { stage: 'analyze', text: '出力DXFを読み直して照合中…' });
    var t2 = now();
    var parsed = DxfAnalyze.parseDxf(dxf);
    report = DxfAnalyze.compare(summary, parsed, log);
    tAnalyze = now() - t2;
  } else {
    report = DxfAnalyze.compare(summary, { entities: {}, blockEntities: {}, objects: {}, tables: {}, texts: [], sections: {}, eofSeen: false }, log);
    report.verdict = 'failed';
    dxf = null;
  }

  // copy out of the engine's filesystem into a transferable buffer
  var out = dxf ? dxf.slice().buffer : null;
  dxf = null;
  post('done', {
    code: code,
    report: report,
    dxf: out,
    log: log,
    timings: { load: tLoad, convert: tConvert, analyze: tAnalyze, total: now() - t0 },
    heapBytes: heapBytes
  }, out ? [out] : []);
}
