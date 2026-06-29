# mckanri

Ubuntu/Linux 上の Node.js で動かす、簡易的な Minecraft Java Edition サーバー管理 Web ツールです。paperのみで動作確認をしております。ブラウザからサーバーの起動・停止、コンソールコマンド送信、ログ確認、バックアップ、設定変更、server.jar アップロード、ファイル管理ができます。
※完全AI製です。

## 必要なもの

- Ubuntu 22.04 以降などの Linux
- Node.js 18 以降
- Java（例: `sudo apt install openjdk-21-jre-headless`）
- Minecraft server jar（Web画面からアップロード可能）

導入方法

```bash
apt update
apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
apt install -y nodejs
npm install -g npm
git clone https://github.com/uu5007mp/mckanri.git
cd mckanri
npm start
```

pm2で動かすのをもおすすめ
`npm install -g pm2`

して

`npm start`を`pm2 start server.js`にしてください

## 起動

```bash
npm start
```

デフォルトでは `http://localhost:3000` で起動します。別ホスト・別ポートで公開する場合は環境変数を指定します。

```bash
HOST=0.0.0.0 PORT=3000 MCKANRI_PASSWORD=change-me npm start
```

または、プロジェクト直下に `.env` を作成して指定できます。

```env
HOST=0.0.0.0
PORT=3000
MCKANRI_PASSWORD=change-me
```

## パスワードの指定場所

ログイン画面ではユーザー名は不要で、管理パスワードだけを入力します。管理パスワードは次の優先順で決まります。

1. 起動時の環境変数 `MCKANRI_PASSWORD`
2. プロジェクト直下の `.env` に書いた `MCKANRI_PASSWORD`
3. Web 画面の「設定」→「管理パスワード変更」で保存した値
4. どれも未設定の場合の初期値 `mckanri`

本番運用では必ず `MCKANRI_PASSWORD` または `.env` で変更してください。環境変数 / `.env` の値は `data/config.json` より優先されます。

## `Password is incorrect` になる場合

ログイン画面に表示される「現在のパスワード指定」を確認してください。

- `MCKANRI_PASSWORD` と表示される場合: 起動コマンドや systemd の環境変数が優先されています。
- `.env` と表示される場合: プロジェクト直下の `.env` の `MCKANRI_PASSWORD` が使われています。`MCKANRI_PASSWORD = value` のように `=` の周りに空白があっても読み込めます。
- `Web設定(data/config.json)` と表示される場合: Web 画面で保存した管理パスワードが使われています。
- `初期値(mckanri)` と表示される場合: パスワードは `mckanri` です。

ログインできなくなった場合は、サーバーを停止して `.env` に `MCKANRI_PASSWORD=新しいパスワード` を書いてから再起動してください。`.env` / 環境変数は `data/config.json` より優先されます。

## 初期設定

1. ブラウザで `http://サーバーIP:3000` を開き、管理パスワードでログインします。
2. Web 画面の「設定」で以下を指定します。
   - サーバーディレクトリ
   - `server.jar` のパス
   - Java コマンド
   - メモリ設定
   - バックアップ先
3. Mojang の EULA を読んで同意した上で「初期化 / EULA同意済みで作成」を押します。
4. 「server.jar アップロード」で Minecraft server jar をアップロードします。`.jar` ファイルは元のファイル名で保存され、設定の `jarPath` も更新されます。
5. 「起動」を押します。

設定は `data/config.json` に保存されます。管理パスワードもここに保存されるため、サーバーのファイル権限を適切に設定してください。

## Web 画面でできること

- パスワードだけのログイン / ログアウト
- サーバー状態確認
- Minecraft サーバー起動 / 停止
- `say hello` や `whitelist add player` などのコンソールコマンド送信
- `logs/latest.log` の確認
- `.jar` アップロード時は元のファイル名を維持（jar専用アップロード時は `jarPath` も更新）
- Pterodactyl風のファイル管理（パンくず移動、ドラッグ&ドロップ追加、ファイル作成、テキスト編集、名前変更、ダウンロード、削除）
- サーバーディレクトリの `.tar.gz` バックアップ作成
- systemd ユニットひな形の表示

## systemd で常駐させる

Web 画面の「systemd表示」ボタン、または次の API でユニットひな形を確認できます。

```bash
curl -c cookie.txt -X POST http://localhost:3000/api/login \
  -H 'content-type: application/json' \
  -d '{"password":"change-me"}'
curl -b cookie.txt http://localhost:3000/api/systemd
```

例:

```bash
curl -b cookie.txt http://localhost:3000/api/systemd | sudo tee /etc/systemd/system/mckanri.service
sudo systemctl daemon-reload
sudo systemctl enable --now mckanri.service
```

## 注意

- このツールはLAN内やVPN内での利用を想定した簡易ツールです。インターネットへ直接公開しないでください。
- 初回起動前に必ず Mojang の EULA を確認してください。
- サーバープロセスはこの Node.js Web ツールから起動した場合に、Web 画面からコンソールコマンドを送れます。
- ファイル管理機能はサーバーディレクトリ内だけを操作できます。テキストエディタは1MB以下のファイルを対象にしています。
- バックアップは `.tar.gz` 形式で作成します。必要に応じて世代管理や外部ストレージへのコピーも併用してください。
