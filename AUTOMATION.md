# ヌシ・オオヌシ情報の自動更新

このプロジェクトは、GitHub Actionsが**毎日12:00 JST**に上流データを再取得し、ヌシ・オオヌシの条件データと画面上の「自動更新の釣り方」を再生成します。

## 自動更新する内容

`tools/build.mjs --refresh` が以下を更新します。

| 項目 | 主な取得元 | 画面上での用途 |
|---|---|---|
| 餌・泳がせ経路・時間・天候・前天候 | FFXIV Fish Tracker | 釣り方、次回ウィンドウ |
| 直感の対象魚・必要数・持続時間 | FFXIV Fish Tracker / GatherBuddy | 釣り方の手順 |
| 引き・フッキング | FFXIV Fish Tracker / GatherBuddy / 実測統計 | フッキングの目安 |
| ヒットタイム・捕獲率 | Lodinnの実測データ | ヒットの目安 |

魚詳細に表示する「自動更新の釣り方」は、上記の構造化データから毎回組み立てます。外部サイトの文章を転載せず、餌、条件、直感、フッキング、実測ヒットタイムという確認可能なデータだけを使います。

## 自動公開前の検査

`tools/validate-bigfish.mjs` が次を検査します。いずれかに失敗した場合、GitHub ActionsはCloudflareやGitHub Pagesへの公開ステップへ進みません。

| 検査項目 | 基準 |
|---|---|
| ヌシ数 | 300種以上 |
| オオヌシ数 | 30種以上 |
| 魚ごとの必須情報 | 釣り場、餌経路、引き、フッキング、時間、天候、直感対象のデータ形式 |
| ET時間帯 | 日付またぎ・端数時刻を含む有効な0〜24時の範囲 |

> 検査に失敗した日は、前回正常に公開されたサイトが維持されます。異常データを自動公開することはありません。

## Cloudflare Workersへの日次自動公開

`wrangler.jsonc` の静的アセット設定を使う場合、リポジトリの **Settings → Secrets and variables → Actions** で次を設定します。

| 種別 | 名前 | 値 |
|---|---|---|
| Variable | `DEPLOY_CLOUDFLARE_WORKER` | `true` |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflareの対象アカウントID |
| Secret | `CLOUDFLARE_API_TOKEN` | 対象アカウントに限定したWorkers編集権限のAPIトークン |

APIトークンはリポジトリへ書き込まず、必ずGitHub ActionsのSecretとして保存してください。設定後は、GitHubの **Actions → ビルドと公開 → Run workflow** を一度実行し、`ヌシ・オオヌシの自動更新を検査` と `Cloudflare Workers へ自動公開` が成功することを確認します。

## ローカル確認

公開前に同じ検査を行う場合は、次を実行します。

```bash
npm run build
node tools/validate-bigfish.mjs
git restore tools/mooch-audit.md
```

`ヌシ検査 OK` が表示されれば、自動公開と同じ品質検査を通過しています。
