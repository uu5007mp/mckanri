# mckanri

Ubuntu/Linux 上の Node.js で動かす、簡易的な Minecraft Java Edition サーバー管理 Web ツールです。ブラウザからサーバーの起動・停止、コンソールコマンド送信、ログ確認、バックアップ、設定変更ができます。

## 必要なもの

- Ubuntu 22.04 以降などの Linux
- Node.js 18 以降
- Java（例: `sudo apt install openjdk-21-jre-headless`）
- Minecraft server jar（`server.jar` など）

## 起動

```bash
npm start
```

デフォルトでは `http://localhost:3000` で起動します。別ホスト・別ポートで公開する場合は環境変数を指定します。

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

## 初期設定

1. ブラウザで `http://サーバーIP:3000` を開きます。
2. Web 画面の「設定」で以下を指定します。
   - サーバーディレクトリ
   - `server.jar` のパス
   - Java コマンド
   - メモリ設定
   - バックアップ先
3. Mojang の EULA を読んで同意した上で「初期化 / EULA同意済みで作成」を押します。
4. Minecraft server jar を設定したパスへ配置します。
5. 「起動」を押します。

設定は `data/config.json` に保存されます。

## Web 画面でできること

- サーバー状態確認
- Minecraft サーバー起動 / 停止
- `say hello` や `whitelist add player` などのコンソールコマンド送信
- `logs/latest.log` の確認
- サーバーディレクトリのバックアップ作成
- systemd ユニットひな形の表示

## systemd で常駐させる

Web 画面の「systemd表示」ボタン、または次の API でユニットひな形を確認できます。

```bash
curl http://localhost:3000/api/systemd
```

例:

```bash
curl http://localhost:3000/api/systemd | sudo tee /etc/systemd/system/mckanri.service
sudo systemctl daemon-reload
sudo systemctl enable --now mckanri.service
```

## 注意

- このツールはLAN内やVPN内での利用を想定した簡易ツールです。インターネットへ直接公開しないでください。
- 初回起動前に必ず Mojang の EULA を確認してください。
- サーバープロセスはこの Node.js Web ツールから起動した場合に、Web 画面からコンソールコマンドを送れます。
- バックアップは `.tar.gz` 形式で作成します。必要に応じて世代管理や外部ストレージへのコピーも併用してください。
