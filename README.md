# 若衆メンバー専用サイト

GASとスプレッドシートを使わず、HTML/CSS/JS + Supabaseで動くメンバー専用サイトです。

## できること

- ログイン後は写真スライドショーの「トップ」ページを表示。次の予定・あなたの未回答件数もひと目で分かる。写真は管理画面からアップロードし、Supabase Storageの非公開バケットに保存されるためログインしていない人には見えない
- メールアドレスとパスワードでログイン、パスワードを忘れた場合の再設定メール送信
- 予定一覧を「予定主体」「人主体」で表示（人主体は名前ではなくIDで名寄せするため同姓同名でも安全）。予定は日ごとに見出しをつけて表示
- 予定作成時に日程調整リンクを自動発行。リンクが無くても「日程調整回答」タブから予定を選んで回答できる
- ログイン中の本人としてしか回答できない（名前を選ぶ必要はない）。参加 / 不参加 / 未定を回答、回答の取り消し（未回答に戻す）
- 回答期限を過ぎると一般メンバーは回答できなくなる（管理者は期限後も編集可能）
- 回答すると画面全体に完了表示が一瞬出る、共有文コピー時もコピー完了が分かる
- 回答内容を予定一覧と人主体表示へ反映、他の利用者の操作もリアルタイムに反映。更新ボタンにも読み込み中表示
- メンバーが回答すると管理者にメール通知、対象者全員の回答がそろうと完了メールも届く（Resend連携、任意設定）
- 管理者だけ予定・メンバーを追加/編集、予定の削除（あとで復元可）、メンバーの退会処理ができる
- 退会・休会・非表示にしたメンバーも、過去の出欠履歴は消えずに残る（表示は「休会/退会/非表示」タグ付き）。退会日が未入力でも自動的に現在・今後の予定からは外れる
- 予定一覧などの表示名は「表示名（苗字など）」を使い、登録上のフルネームは管理画面だけに表示
- メンバー管理は生年月日（年齢は自動計算して薄字表示）、電話番号（ハイフン必須）、袴/Tシャツサイズ、担当を管理
- 予定の「分類」、回答の「理由カテゴリ」の選択肢を管理画面から追加/削除できる
- 操作ログに「誰が」「何を」変更したかを記録
- PCとスマホの両方で見やすいレスポンシブ表示

## 日程調整の流れ

1. 管理者が「管理 > 予定追加」で予定を保存する（予定ごとの日程調整リンクが自動発行される）
2. 共有したい場合は予定カード・管理画面から共有文をコピーして送る
3. メンバーはリンクから開くか、ログイン後に「日程調整回答」タブで予定を選んで回答する
4. 参加 / 不参加 / 未定を回答する（間違えた場合は「回答を取り消す」で未回答に戻せる。回答期限を過ぎると管理者以外は変更不可）
5. 回答結果が予定一覧・人主体表示・ログに反映され、管理者へ通知メールが届く（設定時）

URLは `?schedule=...` の形式です。旧形式の `?answer=...` も読み取れるようにしてあります。

## 旧スプシ構成との対応

| 旧スプシ | このサイトでの扱い |
|---|---|
| 予定ID | `events.id` |
| 区分 / 分類 | `events.category`（選択肢は `list_options` で管理） |
| イベント名 / 予定名 | `events.name` |
| 日にち / 日付 | `events.date` |
| 場所 | `events.place` |
| 場所リンク / 場所URL | `events.place_url` |
| 時間 / 開始時間 / 終了時間 | `events.start_time` / `events.end_time` |
| メンバー列 | `members` テーブル |
| 各メンバーの参加 / 不参加 / 未定 | `answers` テーブル |
| 回答トークン | `events.answer_token` |
| 変更ログ | `logs` テーブル（実行者情報つき） |

## ファイル

| ファイル | 役割 |
|---|---|
| `index.html` | 画面本体 |
| `styles.css` | デザイン（ロゴのブルーを基調にしたテーマ） |
| `app.js` | Supabase連携・表示・保存処理 |
| `config.example.js` | Supabase接続設定のひな形 |
| `supabase-schema.sql` | Supabaseに作るテーブル・権限・移行用SQL |
| `supabase/functions/notify-answer` | 回答通知メール用のSupabase Edge Function（任意設定） |
| `logo.png`（任意） | ロゴ画像。置くとログイン画面のブランドマークとファビコンに自動で使われる |

## 初期設定（新規プロジェクト）

1. Supabaseで新しいプロジェクトを作成する
2. SQL Editorで `supabase-schema.sql` を実行する
3. Authentication > Users で管理者ユーザーを作る
4. 作成したユーザーIDを使って、`supabase-schema.sql` 末尾の管理者登録SQLを実行する
5. `config.example.js` を `config.js` にコピーする
6. `config.js` に Supabase の `Project URL` と `anon public key` を入れる
7. （任意）ロゴ画像を `logo.png` としてこのフォルダに置く
8. （任意）メール通知を使う場合は下記「メール通知の設定」を実施する
9. `index.html` をブラウザで開く、または GitHub Pages / Netlify / Vercel に置く

Supabaseダッシュボードの Authentication > URL Configuration で、Site URL / Redirect URLs に実際に公開するURLを登録してください（パスワード再設定メールのリンク先に使われます）。

## 既存プロジェクトをアップデートする場合（マイグレーション）

過去に一度 `supabase-schema.sql` を実行済みのSupabaseプロジェクトでも、最新の `supabase-schema.sql` をもう一度SQL Editorで実行するだけで安全に反映されます（`if not exists` / `if exists` で書かれているため、既存データは消えません）。これまでのアップデートで以下が追加・修正されています。

- 一般メンバーが自分のroleをadminに書き換えられてしまうRLSの不備を修正
- 出欠回答の書き込み・削除を「本人の分」か管理者のみに制限。さらに回答期限を過ぎた分は管理者以外書き込み不可に
- 操作ログに実行者(`actor_id` / `actor_name`)を記録し、なりすまし insert を防止
- メンバー名の重複防止（同姓同名は登録できません。既に重複がある場合は一意インデックス作成が失敗するので、事前に名寄せしてください）
- 回答理由を `reason_category` / `reason_detail` に分離（旧`reason`列は残るが以後未使用）
- 予定の分類・回答理由カテゴリを管理する `list_options` テーブルを追加
- リアルタイム反映のための `supabase_realtime` publication 登録
- メンバーに `short_name`（表示名）・`birth_date`（生年月日）・`tshirt_size`・`duty`（担当）列を追加（`age`・`bag_size`列は残るが未使用）
- 予定に `completion_notified_at`（全員回答完了メールの二重送信防止）列を追加
- メール通知用のDatabase Webhook基盤（`pg_net` / `supabase_functions` スキーマ）とservice_roleへのGRANTを追加
- トップページ写真用の非公開Storageバケット（`top-photos`）とアクセスポリシーを追加

## メンバーが退会する場合

メンバー一覧・出欠データは常にすべて取得したうえで、表示側で「現役かどうか」を判定する方式になっています。管理画面でメンバーの「在籍状態」を退会にして保存すると、退会日と「現役名簿に表示」が自動でオフになります。退会日を入力し忘れても、在籍状態が「退会」であれば当日以降の予定からは自動的に外れます（過去の出欠履歴は消えず、名前に「（退会）」タグが付いた状態で表示され続けます）。

## トップページの写真について

管理画面の「トップ写真」タブから写真をアップロード/削除できます。保存先はSupabaseの非公開Storageバケット（`top-photos`）で、ログインしたメンバー以外は一切アクセスできません（GitHub Pages上に直接置くとログイン無しでも直リンクで見えてしまうため、あえてこの構成にしています）。

## メール通知の設定（任意・Resend連携）

メンバーが回答すると管理者へ、対象者全員の回答がそろうと完了メールが届く機能です。設定しない場合もサイトの他の機能には影響しません。

1. [Resend](https://resend.com) に登録し、Dashboard > API Keys で「Sending access」権限のAPIキーを発行する
   - 独自ドメインを認証していない場合、Resendはアカウント登録に使ったメールアドレス宛にしか送信できません。複数の管理者に送りたい場合はResendでドメイン認証（DNS設定）が必要です
2. [Supabase CLI](https://supabase.com/docs/guides/cli) を用意し、`supabase login`（[アクセストークン](https://supabase.com/dashboard/account/tokens)を発行して利用）
3. このフォルダで `supabase link --project-ref <プロジェクトref>`
4. 次の秘密情報を設定する（`WEBHOOK_SECRET` は他人にこの通知用関数を叩かれないための合言葉。ランダムな文字列を自分で決める）
   ```
   supabase secrets set RESEND_API_KEY=xxxx ADMIN_NOTIFY_EMAIL=you@example.com NOTIFY_FROM_EMAIL=onboarding@resend.dev WEBHOOK_SECRET=xxxx
   ```
5. Edge Functionをデプロイする
   ```
   supabase functions deploy notify-answer --no-verify-jwt
   ```
6. `supabase-schema.sql` の末尾にある「メール通知」コメント欄のSQLを、実際の `YOUR_PROJECT_REF` と `YOUR_WEBHOOK_SECRET`（手順4と同じ値）に置き換えてSQL Editorで実行し、`answers` テーブルへのWebhookトリガーを作成する
7. メンバーとして回答して、管理者宛にメールが届くか確認する

`ADMIN_NOTIFY_EMAIL` はカンマ区切りで複数指定できますが、Resendでドメイン未認証の場合は登録メールアドレス以外には届きません。

## 公開サイトから飛ばす場合

公開サイト側には、メンバー専用サイトのURLをリンクとして置くだけで大丈夫です。

```html
<a href="https://example.com/wakashu-member-site/">メンバー専用サイト</a>
```

未ログインの人が開いてもログイン画面しか表示されません。

## 注意

- `config.js` に入れる anon key は公開して使う前提のキーです。安全性は Supabase の Row Level Security で守ります。`service_role key` や Resend の API キー、`WEBHOOK_SECRET` は絶対にブラウザ側やリポジトリに置かないでください（Supabaseの `secrets` にのみ保存されます）。
- 新しいメンバーがログインできるようにするには、現状は次の手動手順が必要です（アプリ内に招待機能はまだありません）。
  1. Supabase Authentication > Users でそのメンバーのアカウントを作成する
  2. 発行されたユーザーIDを使って `profiles` テーブルに `role`（`member` / `admin`）と、`members` テーブルの該当行を指す `member_id` を管理者権限で登録する
  3. `member_id` と `role` は管理者以外からは書き換えられないようDBで保護されています
