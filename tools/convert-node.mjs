// Dev-environment test harness: runs the same WASM engine and analyzer the
// web app uses, on files from disk.
//
//   node tools/convert-node.mjs [--as r2000] [--out DIR] [--json] file1.dwg [file2.dwg ...]
//
// Writes DIR/<name>.dxf and DIR/<name>.report.json, prints a one-line verdict
// per file and the detected issues.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const createDwg2Dxf = require(join(root, 'web', 'engine', 'dwg2dxf.js'));
const DxfAnalyze = require(join(root, 'web', 'analyze.js'));

const args = process.argv.slice(2);
let asVersion = '', outDir = join(root, 'out'), jsonOnly = false;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--as') asVersion = args[++i];
  else if (args[i] === '--out') outDir = args[++i];
  else if (args[i] === '--json') jsonOnly = true;
  else files.push(args[i]);
}
if (!files.length) {
  console.error('usage: node tools/convert-node.mjs [--as rNNNN] [--out DIR] [--json] file.dwg...');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const results = [];
for (const file of files) {
  try {
    await convertOne(file);
  } catch (e) {
    // a WebAssembly abort (e.g. out-of-bounds access in LibreDWG) lands here
    const res = { file, code: -1, verdict: 'crash', error: String(e && e.message || e) };
    results.push(res);
    if (!jsonOnly) console.log(`\n== ${basename(file)}  [crash]  ${res.error}`);
  }
}
if (jsonOnly) console.log(JSON.stringify(results.map(({ log, ...r }) => r), null, 1));

async function convertOne(file) {
  const log = [];
  const t0 = performance.now();
  // fresh module per file, like the browser creates a fresh worker
  const mod = await createDwg2Dxf({ print: (l) => log.push(l), printErr: (l) => log.push(l) });
  const tLoad = performance.now() - t0;
  const input = readFileSync(file);
  mod.FS.writeFile('/in.dwg', input);
  const t1 = performance.now();
  const code = mod.ccall('w_convert', 'number', ['string', 'string', 'string', 'string', 'number'],
    ['/in.dwg', '/out.dxf', '/summary.json', asVersion, 1]);
  const tConvert = performance.now() - t1;
  const summary = JSON.parse(mod.FS.readFile('/summary.json', { encoding: 'utf8' }));
  let dxf = null;
  try { dxf = mod.FS.readFile('/out.dxf'); } catch { /* none */ }
  const t2 = performance.now();
  const empty = { entities: {}, blockEntities: {}, objects: {}, tables: {}, texts: [], sections: {}, eofSeen: false };
  const report = DxfAnalyze.compare(summary, dxf && code < 128 ? DxfAnalyze.parseDxf(dxf) : empty, log);
  if (!dxf || code >= 128) report.verdict = 'failed';
  const tAnalyze = performance.now() - t2;
  const name = basename(file).replace(/\.dwg$/i, '');
  if (dxf && code < 128) writeFileSync(join(outDir, name + '.dxf'), dxf);
  const heap = mod.HEAPU8.buffer.byteLength;
  const res = {
    file, code, verdict: report.verdict,
    dwgBytes: input.length, dxfBytes: dxf ? dxf.length : 0,
    ms: { load: Math.round(tLoad), convert: Math.round(tConvert), analyze: Math.round(tAnalyze) },
    heapMB: +(heap / 1048576).toFixed(1),
    report, log
  };
  writeFileSync(join(outDir, name + '.report.json'), JSON.stringify(res, null, 1));
  results.push(res);
  if (!jsonOnly) {
    const r = report;
    console.log(`\n== ${basename(file)}  [${r.verdict}]  code=${code}  ${r.dwg.version} -> ${r.dxf.version || '-'}  ` +
      `dwg=${input.length}B dxf=${res.dxfBytes}B  convert=${res.ms.convert}ms analyze=${res.ms.analyze}ms heap=${res.heapMB}MB`);
    console.log(`   entities: ${r.entityRows.reduce((a, x) => a + x.dwg, 0)} -> ${r.entityRows.reduce((a, x) => a + x.dxf, 0)}` +
      `  texts matched ${r.textCheck.matched}/${r.textCheck.checked} (non-ASCII ${r.textCheck.nonAscii})  layers ${r.dwg.layers}->${r.dxf.layers}`);
    for (const i of r.issues) console.log(`   [${i.level}] ${i.title}${i.detail ? '\n        ' + i.detail.split('\n').slice(0, 4).join('\n        ') : ''}`);
  }
}
