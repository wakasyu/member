# 若衆メンバー専用サイト

GASとスプレッドシートを使わず、HTML/CSS/JS + Supabaseで動くメンバー専用サイトです。

## できること

- メールアドレスとパスワードでログイン
- 予定一覧を「予定主体」「人主体」で表示
- 予定作成時に日程調整リンクを自動発行
- 日程調整リンクから参加 / 不参加 / 未定を回答
- 回答内容を予定一覧と人主体表示へ反映
- 管理者だけ予定・メンバーを追加/編集/削除扱いにできる
- PCとスマホの両方で見やすいレスポンシブ表示

## 日程調整リンクの流れ

1. 管理者が「管理 > 予定追加」で予定を保存する
2. 予定ごとの日程調整リンクが自動で発行される
3. 管理画面の予定一覧、または予定カードから共有文をコピーする
4. メンバーがリンクを開いてログインする
5. 参加 / 不参加 / 未定を回答する
6. 回答結果が予定一覧・人主体表示・ログに反映される

URLは `?schedule=...` の形式です。旧形式の `?answer=...` も読み取れるようにしてあります。

## 旧スプシ構成との対応

| 旧スプシ | このサイトでの扱い |
|---|---|
| 予定ID | `events.id` |
| 区分 / 分類 | `events.category` |
| イベント名 / 予定名 | `events.name` |
| 日にち / 日付 | `events.date` |
| 場所 | `events.place` |
| 場所リンク / 場所URL | `events.place_url` |
| 時間 / 開始時間 / 終了時間 | `events.start_time` / `events.end_time` |
| メンバー列 | `members` テーブル |
| 各メンバーの参加 / 不参加 / 未定 | `answers` テーブル |
| 回答トークン | `events.answer_token` |
| 変更ログ | `logs` テーブル |

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | 画面本体 |
| `styles.css` | デザイン |
| `app.js` | Supabase連携・表示・保存処理 |
| `config.example.js` | Supabase接続設定のひな形 |
| `supabase-schema.sql` | Supabaseに作るテーブルと権限 |

## 初期設定

1. Supabaseで新しいプロジェクトを作成する
2. SQL Editorで `supabase-schema.sql` を実行する
3. Authentication > Users で管理者ユーザーを作る
4. 作成したユーザーIDを使って、`supabase-schema.sql` 末尾の管理者登録SQLを実行する
5. `config.example.js` を `config.js` にコピーする
6. `config.js` に Supabase の `Project URL` と `anon public key` を入れる
7. `index.html` をブラウザで開く、または GitHub Pages / Netlify / Vercel に置く

## 公開サイトから飛ばす場合

公開サイト側には、メンバー専用サイトのURLをリンクとして置くだけで大丈夫です。

```html
<a href="https://example.com/wakashu-member-site/">メンバー専用サイト</a>
```

未ログインの人が開いてもログイン画面しか表示されません。

## 注意

`config.js` に入れる anon key は公開して使う前提のキーです。安全性は Supabase の Row Level Security で守ります。`service_role key` は絶対にブラウザ側に置かないでください。
