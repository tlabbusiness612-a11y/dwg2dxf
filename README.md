# DWG→DXF 変換（端末内・PWA）

DWGファイルを、外部サーバーへ送らずブラウザ内（WebAssembly）でDXFへ変換する試作です。
変換エンジンは GNU LibreDWG 0.14 を Emscripten でWASM化したものです。

検証状況は [docs/REPORT.md](docs/REPORT.md) を参照してください。

## 構成

```
engine/
  wasm_dwg2dxf.c      LibreDWG呼び出し（dwg_read_file → dwg_write_dxf）＋読込内容の要約JSON
  build.sh            WASMビルド（make不要。configureでconfig.hだけ生成し、emccで直接コンパイル）
  patches/            LibreDWG公式リリースへの修正（GPL上の改変記録を兼ねる）
web/                  配布物（このフォルダをそのままHTTPSで配信）
  index.html app.js style.css
  worker.js           変換をWeb Workerで実行。変換ごとにWorkerを作り直し、終了でWASMメモリを解放
  analyze.js          出力DXFを読み直し、DWG側の要約と照合（図形数・文字列・参照・未対応要素）
  sw.js               Service Worker（アプリとエンジンをキャッシュし、オフライン起動）
  engine/dwg2dxf.js / dwg2dxf.wasm   ビルド成果物
tools/
  convert-node.mjs    Nodeで同じエンジン・照合処理を実行する検証ハーネス
  ezdxf_check.py      ezdxf（独立したDXF読込ライブラリ）による出力DXFの再読込チェック
  serve.mjs           開発用静的サーバー（localhost）
  make-icons.mjs      アイコン生成
```

## ビルド

1. Emscripten（検証時 6.0.13）を用意し `emcc` をPATHに通す。
2. LibreDWG 0.14 公式tarballを展開（sha256 `62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275`）。
   https://github.com/LibreDWG/libredwg/releases/download/0.14/libredwg-0.14.tar.xz
3. 実行:

```bash
LIBREDWG_SRC=/path/to/libredwg-0.14 BUILD_DIR=/tmp/build-wasm sh engine/build.sh
```

Windows（Git Bash）では configure が `pkg-config` を要求するため、`--version` にだけ応答するスタブを PATH に置く（build.sh 冒頭のコメント参照）。

## 開発環境での確認

```bash
node tools/convert-node.mjs --out out path/to/drawing.dwg
```

`out/<名前>.dxf` と `out/<名前>.report.json`（判定・問題一覧・図形数比較・ログ）を出力します。

```bash
node tools/serve.mjs 8765
```

http://localhost:8765 でPWAを確認できます（localhostはService Workerが動作する安全なコンテキスト）。

## 実機検証用の一時公開（Cloudflare Quick Tunnel）

```bash
node tools/serve.mjs 8766 --samples samples
```

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:8766
```

表示される `https://*.trycloudflare.com` をiPhoneで開きます。`/samples/` に検証用DWGがあります。
`--testdata` は付けないこと（開発用のテストデータ配信は公開しない）。
URLはcloudflaredを再起動するたびに変わり、オリジンが変わるため、ホーム画面アプリやキャッシュも別物になります。

## 配布（iPhone/iPad Safari）

公開URL: https://tlabbusiness612-a11y.github.io/dwg2dxf/ （`gh-pages` ブランチ = `web/` の中身）

- 初回: HTTPSでページを開く → アプリ・エンジン（約6MB）を端末に保存 → 「ホーム画面に追加」。
- 以降: 機内モードでも起動・変換・保存が可能（端末内の保存データが残っている限り）。
- 変換時: 図面データの通信は発生しません（ページは自オリジン以外へ接続せず、CSPで `connect-src 'self'` に制限）。

### 更新は手動

アプリは起動時に更新を取りに行きません。画面下の「更新を確認」を押した時だけ `version.json` を取得し、
版が違えば全ファイルを新しいキャッシュに取り込んでから切り替えます（途中で失敗したら旧版のまま）。

ブラウザ自身は起動時に `sw.js` を再取得して変更を確認することがあり、これはアプリ側では止められません。
そのため **`web/sw.js` は原則変更しない**（変更すると自動で入れ替わる）。

リリース手順:

1. `web/app.js` の `APP_VERSION` を上げる
2. `node tools/make-version.mjs X.Y.Z` で `web/version.json` を更新
3. main にコミットし、`git subtree push --prefix web origin gh-pages` で公開

## ライセンス

GPL-3.0-or-later（LibreDWGがGPLv3のため）。[LICENSE](LICENSE)、[web/SOURCE.txt](web/SOURCE.txt) 参照。
他人へ配布（Webで公開する場合を含む）する際は、対応するソース一式を入手可能にする必要があります。
