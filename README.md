# YouTube Archive Queue

YouTubeチャンネルの動画・ライブアーカイブ・Shortsを、チャンネルページの並び順に沿って連続再生するChrome拡張です。

> Beta: YouTubeの画面構造変更により動作しなくなる可能性があります。不具合は再現したチャンネルURLと操作手順を添えて報告してください。

## 主な機能

- 新しい順／古い順でキューを作成・再生
- 配信予定・プレミア公開予定を自動除外
- 動画終了後に同じキューの次の動画へ移動
- チャンネル別のキューと再生位置をローカル保存
- 保存済み動画まで到達したら止まる差分更新
- 専用管理ページから「続きから再生」
- タイトル検索、視聴状態フィルター、複数選択
- 視聴済み管理、除外・復元、ドラッグ並べ替え
- JSONバックアップ・復元
- 外部サーバー、広告、分析、トラッキングなし
- GitHub Pagesで最新版を確認し、更新がある場合は管理ページで通知

## ベータ版のインストール

1. [Releases](../../releases)から`youtube-archive-queue-v0.5.8-beta.1.zip`をダウンロードする
2. ZIPを任意のフォルダーへ展開する
3. Chromeで`chrome://extensions`を開く
4. 右上の「デベロッパー モード」を有効にする
5. 「パッケージ化されていない拡張機能を読み込む」を押す
6. 展開した`youtube-archive-queue`フォルダーを選択する

Chrome Web Store版はまだありません。ZIPを更新した場合は、同じ場所へ展開して`chrome://extensions`の再読み込みボタンを押してください。

## 基本的な使い方

1. YouTubeチャンネルの「動画」「ライブ」または「Shorts」タブを開く
2. 右下のArchive Queueで「新しい順」または「古い順」を選ぶ
3. 「キューを作成して再生」を押す
4. 以降は動画終了時に次の動画へ進む

Chromeツールバーの拡張アイコンを押すと、保存した全チャンネルを管理できます。

詳しい機能説明は[拡張内README](youtube-archive-queue/README.md)を参照してください。

## 保存するデータ

キュー、動画タイトル・URL・サムネイルURL・配信日、視聴状態、再生位置、除外状態をChromeのローカルストレージへ保存します。外部サーバーには送信しません。詳細は[プライバシーポリシー](PRIVACY.md)を参照してください。

## 必要な権限

- `storage`: キューと視聴進捗の保存
- `unlimitedStorage`: 複数チャンネル・大量動画のキュー保存
- `https://www.youtube.com/*`: チャンネル一覧の取得と連続再生UIの表示

## 既知の制限

- YouTubeのDOMに依存しているため、YouTube側の変更で取得できなくなる場合があります。
- 一覧に表示されない非公開・削除済み動画は新規キューへ追加できません。
- 取得上限は1チャンネル10,000件です。
- Chrome以外のChromiumブラウザーは未検証です。

## 開発

拡張本体は`youtube-archive-queue/`にあります。依存パッケージやビルド工程はありません。

```text
youtube-archive-queue/
├── manifest.json
├── content.js
├── background.js
├── manager.html
├── manager.js
├── manager.css
└── styles.css
```

配布ZIPの作成：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\package-release.ps1
```

## ライセンス

ライセンスは未設定です。現時点では無断での再配布・改変・商用利用を許諾していません。
