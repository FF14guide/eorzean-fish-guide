# 公開までの手順

ドメインは買わなくていい。無料のサブドメインが付いてくる。
GitHub を起点にすれば、あとは自動で更新され続ける。

所要時間は 30〜40 分。費用はゼロ。

---

## 全体像

```
GitHub リポジトリ ──┬─→ GitHub Actions が毎週データを取り直してコミット
                    │
                    └─→ 公開先が push を拾って自動でビルド・公開
```

公開先は2択。**Cloudflare Pages を薦める**が、GitHub Pages だけでも動く。

| | Cloudflare Pages | GitHub Pages |
|---|---|---|
| アカウント | GitHub + Cloudflare | GitHub のみ |
| URL | `xxx.pages.dev` | `ユーザー名.github.io/リポジトリ名` |
| キャッシュ | `_headers` が効く。再訪が明確に速い | 10分。毎回 654 KB 落とし直す |
| 設定 | 画面で数項目 | リポジトリ変数を2つ足すだけ |

このプロジェクトはデータが 2.8 MB あるので、キャッシュの差がそのまま体感に出る。
迷うなら Cloudflare。

---

## 手順1：GitHub にリポジトリを作る（10分）

### 1-1. アカウント

<https://github.com/signup> でアカウントを作る。メールアドレスとユーザー名だけ。
**ユーザー名はそのまま URL に出る**ので、それなりのものにしておくといい。

### 1-2. リポジトリ

1. 右上の **＋ → New repository**
2. Repository name に `eorzean-fish-guide`
3. **Public** を選ぶ（Private だと GitHub Pages が有料プラン限定になる）
4. 下のチェックは**すべて外したまま**
5. **Create repository**

### 1-3. 手元から push する

`eorzean-fish-guide-source.zip` を展開したフォルダで。
Git を入れていなければ <https://git-scm.com/downloads> から。

```bash
cd eorzean-fish-guide       # 展開したフォルダ

git init
git add .
git commit -m "エオルゼア釣り図鑑"
git branch -M main
git remote add origin https://github.com/ユーザー名/eorzean-fish-guide.git
git push -u origin main
```

初回の push で GitHub のログインを求められる。
ブラウザが開くのでそこで許可すればいい（パスワードではなくトークンが使われる）。

> `dist/` と `tools/.cache/` は `.gitignore` に入れてある。
> ビルド結果とダウンロードキャッシュは毎回作り直すので、リポジトリには入れない。
> `data/` は入れる。Actions がここを更新していく。

ブラウザでリポジトリを開いて README が表示されれば成功。

---

## 手順2：公開する

### A. Cloudflare Pages（推奨）

1. <https://dash.cloudflare.com/sign-up> でアカウントを作る
2. 左メニューの **Compute (Workers) → Pages** → **Git に接続**
3. GitHub を認可して `eorzean-fish-guide` を選ぶ
4. ビルド設定を入れる

   | 項目 | 値 |
   |---|---|
   | フレームワーク プリセット | なし（None） |
   | ビルドコマンド | `node tools/import-bite-times.mjs && node tools/build.mjs` |
   | ビルド出力ディレクトリ | `dist` |

5. **保存してデプロイ**
6. URL が確定したら、設定 → 環境変数に `SITE_URL` を追加して、もう一度デプロイ
   （OGP と sitemap の絶対URLのため。無くてもサイトは動く）

数分で `https://eorzean-fish-guide.pages.dev` が公開される。
以後、GitHub に push があるたびに自動で作り直される。

### B. GitHub Pages だけで済ませる

1. リポジトリの **Settings → Pages → Source** を **GitHub Actions** に変更
2. **Settings → Secrets and variables → Actions** の **Variables** タブで
   **New repository variable** を2つ作る

   | 名前 | 値 |
   |---|---|
   | `DEPLOY_GITHUB_PAGES` | `true` |
   | `SITE_URL` | `https://ユーザー名.github.io/eorzean-fish-guide` |

3. **Actions** タブ → 左の「ビルドと公開」 → **Run workflow**

`DEPLOY_GITHUB_PAGES` を設定しない限り公開のステップは動かない。
Cloudflare を使う人のところで無駄に失敗しないようにしてある。

---

## 手順3：自動更新の確認

`.github/workflows/build.yml` が毎週月曜の正午（JST）に走る。

1. 上流のコミュニティデータを取り直す
2. ヒットタイムの実測を取り込む
3. 差分があれば `data/` をコミットして push
4. （`DEPLOY_GITHUB_PAGES` が `true` のときだけ）GitHub Pages に公開

Cloudflare Pages を使っている場合は、3 の push を Cloudflare が拾って再ビルドする。
つまりどちらの構成でも、放っておけば最新に追従する。

パッチ直後など待てないときは **Actions タブ → Run workflow** で手動実行できる。

### 設定できる変数

**Settings → Secrets and variables → Actions → Variables**

| 名前 | 用途 |
|---|---|
| `SITE_URL` | OGP・canonical・sitemap の絶対URL |
| `ICONS` | `off` にするとアイテムアイコンを出さない |
| `DEPLOY_GITHUB_PAGES` | `true` のときだけ GitHub Pages に公開する |

---

## 独自ドメイン（欲しくなったら）

`.pages.dev` のままでも困らない。それでも取るなら年 1,000〜2,000 円程度。

- **取得**：Cloudflare Registrar（原価に近い）、お名前.com、Squarespace Domains など
- **繋ぎ方**：Cloudflare Pages のプロジェクト → **カスタムドメイン** → ドメインを入力
  → 表示された DNS レコードを設定。証明書は自動で付く
- 繋いだら `SITE_URL` を新しいドメインに変えて再デプロイする

> ドメイン代は運営費であって収益ではないので、著作物利用条件の
> 「商用・営利目的」には当たらない。
> ただし**広告や投げ銭で回収しようとすると抵触する**。

---

## 公開したあとに決めること

### 連絡先を出す

著作物利用条件には「当社から依頼があれば遅滞なく利用を中止する」とある。
連絡が取れる窓口を置いておくと、いきなり止められるより話が早い。
GitHub の Issues でも、X のアカウントでもいい。

出すなら `app/index.html` の `creditHTML()` に1行足して push すれば反映される。

### アイコンの扱い

既定では XIVAPI からアイテムアイコンを読んでいる。
ゲームから取り出したアイコンファイルは、著作物利用条件が列挙している
「利用できる著作物」に入っていない（詳しくは README）。

安全側に倒すなら Variables に `ICONS` = `off` を追加して再ビルド。

### 名前を変えるなら

`app/index.html` の `<title>`、`.brand`、OGP のメタタグ。
`tools/build.mjs` は触らなくていい。

### 告知

FF14 の釣り勢は Discord に集まっている。
Fisherman's Horizon や日本語の漁師コミュニティが早い。
ヌシの次回日時とヒットタイム分布は既存のどのサイトにもない形なので、そこを前に出すといい。

---

## つまずいたら

**push で認証を求められ続ける**
→ GitHub のパスワードではなくトークンが必要。ブラウザ認証が出るならそれに従う。
   出ないなら Settings → Developer settings → Personal access tokens (classic) で
   `repo` 権限のトークンを作り、パスワード欄に貼る。

**Actions が「データの更新をコミット」で失敗する**
→ Settings → Actions → General → Workflow permissions を
   **Read and write permissions** にする。

**Cloudflare のビルドが Node のバージョンで落ちる**
→ 環境変数に `NODE_VERSION` = `20` を追加する。

**ビルドは通るのにページが真っ白**
→ 出力ディレクトリが `dist` になっているか確認。
   ブラウザの開発者ツールのコンソールに読み込みエラーが出ていないかも見る。

**とりあえず動くものを先に見たい**
→ `dist-drag-and-drop.zip` を Cloudflare Pages の「アップロード」に投げれば、
   Git なしで即公開できる。あとから Git 連携に切り替えればいい。

---

## まとめ

1. GitHub アカウント → リポジトリ作成 → `git push`
2. Cloudflare Pages に Git 接続、ビルドコマンドと出力先を設定
3. URL が出たら `SITE_URL` を入れて再デプロイ

ここまでで公開完了。以後は毎週勝手に最新化される。
GitHub Pages だけで済ませたい場合は、2 の代わりに Variables を2つ足すだけ。
