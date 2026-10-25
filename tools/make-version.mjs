// Writes web/version.json: the release version and every file the service
// worker must cache for offline use. Run after changing anything in web/.
//   node tools/make-version.mjs 0.2.0
// The version must also match APP_VERSION in web/app.js.
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
  console.error('usage: node tools/make-version.mjs X.Y.Z');
  process.exit(2);
}
const appVersion = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(web, 'app.js'), 'utf8'))?.[1];
if (appVersion !== version) {
  console.error(`APP_VERSION in web/app.js is ${appVersion}, expected ${version}`);
  process.exit(1);
}

// sw.js is fetched by the browser itself; version.json must always come from the network
const skip = new Set(['sw.js', 'version.json', '.nojekyll']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(web, p).split('\\').join('/');
      if (!skip.has(rel)) files.push(rel);
    }
  }
})(web);

writeFileSync(join(web, 'version.json'), JSON.stringify({ version, files: ['./', ...files] }, null, 1) + '\n');
console.log(`web/version.json: ${version}, ${files.length + 1} entries`);
