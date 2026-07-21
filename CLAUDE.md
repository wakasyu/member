# 若衆メンバー専用サイト — プロジェクト状況（2026-07-21時点）

このファイルは「今このプロジェクトが何であり、何が済んでいて、何が未確認か」を
会話の続きが無くても把握できるようにするための引き継ぎメモ。README.mdは利用者向け、
このファイルは開発を引き継ぐ側（Claude自身も含む）向け。詳細な変更履歴は`git log`を参照。

## プロジェクトの概要

- 若衆（伝統的な青年団）のメンバー専用サイト。GAS/スプレッドシート運用をやめて、
  素のHTML/CSS/JS + Supabase（Postgres, Auth, Storage, Edge Functions）で作った。
- ビルドツール無し。`index.html` を直接ブラウザで開くか、GitHub Pagesで配信。
- リポジトリ: https://github.com/wakasyu/member （public）
- 公開URL: https://wakasyu.github.io/member/
- Supabaseプロジェクトref: `szedtsppkoknipvsiekq`

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | 画面本体（ログイン/登録/トップ/予定一覧/出欠回答/日程アンケート/予定追加/管理） |
| `styles.css` | デザイン。ロゴのブルーを基調にしたテーマ |
| `app.js` | 全ロジック（Supabase連携・描画・保存処理すべてここ） |
| `config.js` | 実際のSupabase URL/anon key（公開前提のキーなのでコミット済みでOK） |
| `config.example.js` | ひな形 |
| `manifest.json` | ホーム画面追加用（PWA的なアイコン設定） |
| `supabase-schema.sql` | テーブル・RLS・Storageバケット・Webhook基盤。**何度実行しても安全**（if not exists / if existsで書いてある） |
| `supabase/functions/notify-answer/index.ts` | 出欠が全員分揃った時の管理者向け通知メール（Resend） |
| `supabase/functions/register-member/index.ts` | メンバー自己登録（招待リンク）用の公開エンドポイント |
| `supabase/functions/delete-member/index.ts` | メンバー削除時にSupabase Authアカウントも削除する管理者専用エンドポイント（`--no-verify-jwt`にせず、呼び出し元が管理者かをJWTから検証） |
| `supabase/functions/deadline-reminder/index.ts` | 回答期限が明日の予定について、未回答メンバーへリマインドメールを送る。pg_cronから毎日1回起動される想定（`--no-verify-jwt`＋x-webhook-secretで認可） |
| `logo.jpg` | 実際のクラブロゴ（Instagramアイコン用の正方形画像、丸枠で表示）。ブラウザのタブアイコン（favicon）とログイン画面・ヘッダーのロゴに使用 |
| `home-icon.jpg` | スマホでホーム画面に追加した時だけに使う専用アイコン（`apple-touch-icon`と`manifest.json`のicon）。「政やの絆 若衆」のバナーロゴ |
| `README.md` | セットアップ手順・機能一覧（利用者向け） |

## ロール（3種類）

- **admin（管理者）**：全操作可能。画面右下に「編集/閲覧/メンバー」の表示モード
  切替ボタンがある（DBのroleやRLSは変えない、見た目・操作範囲だけの表面的な
  切替）。閲覧モードは管理画面は使えるが他メンバーの出欠には触れない、
  メンバーモードは一般メンバーと同じ見た目になる。
- **member（メンバー）**：自分の出欠回答、日程アンケートへの入力ができる。
- **staff（政やスタッフ）**：個別アカウントではなく、スタッフ全員共通の
  1つのSupabaseアカウント（固定メールアドレス＋共通パスワード）でログイン。
  ログイン時に入力した名前がそのセッション中「作成者」欄に自動入力される。
  見えるのは「予定一覧」と「予定追加」タブのみ。

## できていること（機能一覧）

- ログイン（メール/パスワード）、パスワード再設定メール、スタッフ共通ログイン
- メンバー自己登録：管理画面から「新規メンバー登録リンクを発行」すると、
  リンクを開いた本人がログイン不要で名前・連絡先・メールアドレス等を入力するだけで
  membersテーブルの行が新規作成され、Supabase Authアカウントも作られる
  （初期パスワードは登録の都度ランダム発行し、登録直後の画面とメールにのみ表示。
  ログイン時`user_metadata.must_change_password`が立っているとアプリ本体に
  入れず強制的にパスワード変更画面へ誘導する。旧固定パスワード「password」は
  廃止済み）。登録完了時にGmail SMTP経由でお祝いメールを送信
- トップページ：Storageの非公開バケット（`top-photos`）から写真を取得し
  全画面背景でスライドショー表示。次の予定・自分の未回答件数はタブと同じ行に
  ピル表示（写真を邪魔しない）
- 予定一覧：日ごとに見出し、予定ごとにカード表示。カードは分類ごとに
  左帯の色分け（`categoryColorIndex()`で文字列から決定的に算出、DBに
  色は持たない）、見出し（日付・分類・予定名）を強調し、本文（回答欄）は
  既定で折りたたみ・「要回答」（自分が未回答）の予定だけ自動展開する
  （`expandedEventOverrides`で手動での開閉上書きも記憶）。日付は日ごとの
  見出し側にしか出さない（カード内では重複表示しない）。各予定の各メンバー
  欄に参加/不参加/未定/時間限定ボタンが直接あり、別画面に遷移せずその場で
  回答できる。名前をクリックすると理由・時間帯などの詳細欄が開閉する
  （不参加/未定/時間限定を選ぶとその場で自動的に開く）。管理者は全メンバー分
  をその場で代理回答でき（代理変更中の項目には注意書きを表示）、予定の
  「編集」ボタンからそのまま編集画面へ飛べる。
  **その場回答は即時保存ではなくバッチ方式**：`inlineAnswerPendingChanges`
  （Map、キーは`{answerToken}_{memberId}`）に保留し、`buildPublicEvent()`が
  DBの値の上にこの保留分を重ねて表示する（`isPending`フラグ、未保存タグ・
  破線枠で表示）。右下固定の「回答完了」ボタン（管理者は表示モード切替の
  直上に位置をずらす）でまとめてDB反映、「キャンセル」で破棄。
  `rebuildPublicEvents()`はDB再取得せず`lastRawEvents`/`lastRawAnswers`
  キャッシュから再構築する。ページ離脱時は`beforeunload`で警告。
  自分以外のメンバーを代理変更中の項目には注意書きを表示
- 出欠回答（レガシー画面）：予定を選んで回答する専用画面。管理者のみ
  「代理入力するメンバー」を選択可能。回答期限を過ぎると一般メンバーは
  編集不可（UIとRLS両方で強制）。この画面と予定一覧のその場回答は
  フィールド構成が完全に重複しており、招待リンク（`?schedule=`）経由の
  アクセスのため残している
- 日程アンケート：特定の1予定の出欠とは別の仕組み。管理者が「候補日」を
  選んで作成する（`availability_poll_days`テーブル、候補日ごとに個別の
  開始・終了時刻を持てる。日付は連続している必要はなく、飛び石でもよい。
  2026-07-21にperiod_start〜period_end＋1日共通の時間帯という旧モデルから
  この個別候補日モデルへ移行済み）。管理画面の作成フォームは2ステップ：
  (1) 月表示カレンダー（`renderPollFormCalendar()`）から候補日を複数タップで
  選び「完了」を押す (2) 各候補日の時間帯を、メンバー側と同じ`.poll-cell`の
  ドラッグ選択UI（`onPollFormCellDown/Enter/Up`、`pollFormDayTimes`：
  dateISO→選択中のstartMinutesのSet）でスワイプ指定する。保存時に各日の
  選択が「隙間なく連続しているか」を検証し（歯抜けはエラー）、
  min/maxから`start_minutes`/`end_minutes`を算出してDBへ保存する
  （`savePollForm()`）。時間の単位（15/30/60分）を選択後に変更すると
  既存の塗りつぶしはリセットされる（`onPollFormSlotMinutesChange()`）。
  メンバー側の回答画面はGoogleカレンダー風のグリッドを
  ドラッグして空き時間を申告する（1時間ごとの行、15/30分刻みは色分け
  ブロックで表現）。グリッドの縦軸（時間帯）は全候補日をまたいだ
  最早開始〜最遅終了の共通軸で、各候補日ごとにその日の時間帯外のマスは
  `.poll-cell.unavailable`として選択不可・非表示にする（`getPollTimeRange()`）。
  候補日が8日を超える場合はページ送り（`movePollPage()`、1ページ7日）で表示する
  （period_start/period_end/day_start_minutes/day_end_minutesは一覧のソート等の
  補助情報として、候補日から算出したmin/maxを引き続き保存するだけで、
  グリッド描画には使わない）。「入力開始」を押すまではグリッドがロック
  （グレーアウト＋`touch-action:none`解除）され、誤スワイプでの意図しない
  選択を防ぐ。ドラッグ選択は「完了」ボタンで確定保存。結果表示ではタッチ
  スクロール可能（`touch-action:pan-x pan-y`）で重なりをヒートマップ表示し
  「空いている時間帯トップ3」「参加可能人数が多い日トップ3」を自動提案。
  備考欄、管理者代理入力、リセットボタンにも対応。キーボード操作にも対応
  （Tab移動＋Enter/Spaceでトグル）。`events`と同様`answer_token`による
  共有リンク（`?poll=...`）を発行可能。`.poll-grid-wrap`は`max-height:60vh`＋
  `overflow:auto`で縦横ともスクロール可能にし、見出し行（日付）・時刻ラベル列を
  `position:sticky`で固定している（2026-07-21に修正。**ハマりどころ**：
  `overflow-x`だけをautoにすると仕様上`overflow-y`も自動でautoへ変換されるが、
  高さが`auto`のままだとその要素自身は縦に実際スクロールしないため、
  sticky要素の基準（＝最も近いスクロールコンテナ）としては機能せず、
  見出し行が固定されない。`overflow-x`だけ指定して`overflow-y:visible`を
  期待する書き方は成立しないので、スクロールを固定したい方向には必ず
  `max-height`等で実際にスクロールする箱を作ること）
- 予定追加・編集フォーム：対象メンバーは全員にチェックボックスがあり自由に
  絞り込める（未変更なら在籍期間から自動判定、日付を変えると自動でプレビューが
  更新される。一度でも手動でチェックを変えたらそれ以降は上書きされない）。
  管理者は対象メンバーごとにその場で出欠を事前入力することも可能。
  開始・終了時刻は時/分のプルダウン（ネイティブtime inputのスピナーが
  59→00で無限ループする挙動を回避）。スタッフも対象メンバーの絞り込みは
  可能（事前代理回答は管理者のみ）。このフォームは同じDOM要素をロール別に
  出し分けており（`mountEventFormPanel()`）、管理者では上部タブの
  「予定追加」自体を非表示にし、「管理 > 予定一覧」の「予定を追加」または
  各予定の「編集」ボタンでその場に展開・入力後は完了ポップアップと共に
  折りたたまれる（`openEventForm()` / `closeEventForm()`）。スタッフは
  従来通り上部タブの専用画面（フルページ）のまま
- 管理画面：予定/メンバーのCRUD、削除は論理削除（予定は復元可）、
  分類・理由カテゴリの選択肢管理（名称変更も可）、操作ログ（実行者名も記録）、
  トップ写真管理、メンバー表示順の並び替え（▲▼ボタン）、メンバー削除
- 管理者用テーブルは幅700px以下でカード表示に自動切替（横スクロール不要）
- メール通知（Resend経由）：回答が対象メンバー全員分揃った時だけ管理者に通知
- 回答期限リマインドメール（Resend経由）：予定の`answer_deadline`が翌日（JST）
  になった時点で、その予定にまだ未回答のメンバーがいれば、予定名・未回答者名を
  まとめて管理者（`ADMIN_NOTIFY_EMAIL`）へ通知する（メンバー本人への個別送信
  ではなく、管理者が声かけできるようにするためのもの）。
  `supabase/functions/deadline-reminder`をpg_cronから毎日1回
  （23:00 UTC = 8:00 JST想定）起動する設計で、行の変更では起動できないため
  notify-answerとは別方式（pg_cron + `net.http_post`）を使う。送信はnotify-answer
  と同じResend/ADMIN_NOTIFY_EMAILを共用（宛先が管理者1人だけなのでGmail SMTPは
  不要）。二重送信防止に`events.reminder_sent_at`を使用。対象者・未回答判定の
  ロジックはnotify-answerの「全員回答完了」判定と同じ考え方を流用
- リアルタイム反映（Supabase Realtime）
- ホーム画面追加用アイコン（apple-touch-icon + manifest.json）
- 右下固定UI（表示モード切替・回答完了バー）はページ最下部のボタン等に
  重ならないよう、表示されている時だけ`#appShell`に`padding-bottom`を
  確保する（`updateFloatingUiClearance()`、`.shell.has-mode-switcher` /
  `.has-answer-bar`）。回答完了バーはスタッフには表示しない（出欠回答をしない
  ため）。バーの幅は表示モード切替の外枠幅にJSで揃えている
  （`updateInlineAnswerBar()`が`--inline-answer-bar-width`を設定）
- フォーム（特にdate/time系のネイティブ入力）がグリッドレイアウトから
  はみ出す問題に対し、グリッドセル（`.grid label`等）への`min-width:0`と
  input/select/textarea全体への`max-width:100%`で対策済み（iOS Safari特有の
  「date/time入力欄がCSS指定幅より広く描画される」挙動への対策。Chromium系
  ブラウザでは再現しないため実機での見た目は都度確認が必要）

## データベース・インフラの状態

- `supabase-schema.sql` は繰り返し実行安全。**このファイルを更新したら
  Supabase側でSQL Editorで再実行してもらう必要がある**（自動デプロイの
  仕組みは無い）。2026-07-17時点の内容（`event_target_members`テーブル、
  `profiles.role`への`staff`追加、`is_staff()`、`answers.limited_start_time`/
  `limited_end_time`列とstatusのcheck制約更新、`availability_polls.answer_token`
  列を含む）まで、CLIの`db query --linked`で直接適用済みを確認。
- Storageバケット `top-photos`：非公開。RLSで「認証済みなら閲覧可、
  書き込みは管理者のみ」。
- Edge Function `notify-answer`：デプロイ・secrets設定済み（動作確認済み）。
  `RESEND_API_KEY` / `ADMIN_NOTIFY_EMAIL` / `NOTIFY_FROM_EMAIL` / `WEBHOOK_SECRET`。
- Edge Function `register-member`：登録完了メールは
  Resendではなく **Gmail SMTP**（`GMAIL_USER` / `GMAIL_APP_PASSWORD` secrets、
  denomailer経由）で送信するよう変更済み（Resendは送信ドメイン未認証だと
  任意の宛先に送れないため）。2026-07-17に初期パスワード発行ロジックと
  招待トークンの排他制御を変更し、`supabase functions deploy register-member
  --no-verify-jwt` でv5としてデプロイ済み（ACTIVE、実際の登録で動作確認済み・
  ランダムパスワード発行とメール送信を確認）。
- Edge Function `delete-member`：2026-07-18にデプロイ済み（ACTIVE）。
  `supabase functions deploy delete-member`（`--no-verify-jwt`は付けない。
  register-memberと違い誰でも叩けると困るため、呼び出し元のJWTを
  `auth.getUser()`で検証し`profiles.role === 'admin'`を確認してから
  `auth.admin.deleteUser()`を実行する）。管理画面の「メンバー削除」が
  このFunctionを呼ぶよう`deleteMember()`を変更済み。これが無い間に
  自己登録→サイト側で削除、を繰り返すとSupabase Auth側にアカウントだけ
  孤立して残り、同じメールアドレスで再登録できなくなる不具合があった
  （2026-07-18に発覚、孤立していた3件のテストアカウントも削除して解消済み）。
- Resendは無料枠でドメイン未認証のため、`ADMIN_NOTIFY_EMAIL`に設定した
  アカウント登録メール以外には送信できない（notify-answer用。register-member
  の方は上記の通りGmail SMTPに切り替え済みなのでこの制限を受けない）。
  他の管理者にはGmailの転送フィルタで届くよう設定済み。
- Edge Function `deadline-reminder`：2026-07-21に実装。**まだ未デプロイ・
  pg_cronも未設定**（コードとschema.sqlの記述だけ用意した段階。デプロイ・
  `pg_cron`拡張の有効化・secrets設定・cronジョブ登録はユーザー確認後に実行する
  予定）。デプロイ手順はsupabase-schema.sqlの該当コメント欄を参照。
- `availability_poll_days`テーブルを2026-07-21に追加（日程アンケートの
  候補日ごとの時間帯管理用）。既存アンケートは`supabase-schema.sql`内の
  1回限りの移行SQLで自動的に新モデルへ移行される（候補日が1件でもあれば
  移行済みとみなしてスキップする、冪等な設計）。
- Supabase Personal Access TokenやCLIログインは作業のたびに一時的に
  発行してもらい、作業後は失効させる運用。

## 未確認・保留中の項目

- スタッフ用の共通Supabaseアカウントは**意図的に未作成**（必要になったら
  作成する方針。手順：ダッシュボードのAuthentication > Usersで、メール
  アドレスを`app.js`内の`STAFF_LOGIN_EMAIL`（`staff@wakasyu.local`）と
  完全一致させて作成し、SQL Editorで
  `insert into public.profiles (id, display_name, role) values ('（UUID）', 'スタッフ', 'staff');`
  を実行する）
- 日程アンケートのグリッドは月カレンダー表示ではなく、候補日を最大7日ずつ
  ページ送りする形（`movePollPage()`）。候補日が7日を超えるアンケートでの
  実機確認はまだ行っていない
- メンバーのログインアカウント発行は招待リンクでセルフサービス化済み。
  管理者アカウントの追加だけは今もダッシュボードからの手動作業
- **2026-07-18時点でコードは修正・push済みだが、ユーザーの実機（iOS Safari）で
  まだ見た目を確認できていないもの**（Claudeのブラウザ検証はChromium系エンジン
  のため、iOS Safari特有の描画バグはコード上の対策のみで実機未確認）：
  - 予定一覧カードの再デザイン（分類色の左帯・折りたたみ）
  - 右下固定バーの幅・重なり対策一式
  - フォームのgrid/date-time入力はみ出し対策
  - 2026-07-21の日程アンケート再設計（日ごとに時間帯が違うグリッドの
    `.poll-cell.unavailable`表示、ページ送り、月表示カレンダーでの候補日
    複数タップ選択、時間帯のスワイプ指定UI）はブラウザ検証で数値・DOM構造は
    確認済みだが、実機（特にスマホでのタップ・スワイプ操作感）は未確認
- 予定一覧の月表示（いつ・何の予定か一目で分かるレイアウト）の改善は
  A（見出しバー強調）/B（分類色の左帯）/C（折りたたみ）のハイブリッド案で
  実装済み。追加調整の要望があれば都度対応する方針

## 作業の進め方（このプロジェクトでの申し合わせ）

- 変更は都度 `git commit` → `git push` している（実行前に必ずユーザーに確認）
- SupabaseのCLI（`supabase db query --linked`でのDB確認・更新、
  `supabase functions deploy`でのデプロイ）はこのセッション内では認証済み
  セッションが有効だったため、Claudeが直接実行している。本番データの変更・
  Edge Functionのデプロイなど影響が大きい操作は、実行前に必ずユーザーに
  内容を説明して確認を取ってから実行する運用（過去の「ユーザー自身の
  PowerShellで」という前提より、実態はClaudeが直接叩くことが増えている）
- ブラウザでの動作確認は、実際のSupabaseアカウントでログインする代わりに
  `currentProfile`/`publicData`等の状態をJS経由で直接注入し、ログイン不要で
  各ロール（管理者/メンバー/スタッフ）や各画面状態を再現して検証している
  （パスワード入力は一切行わない）。DB書き込みを伴う関数は
  `supabaseClient.from`や`fetch`をモックして呼び出し内容だけ検証することが多い
- iOS Safari特有の描画差異（date/time inputのはみ出し等）はChromium系の
  ブラウザ検証では再現しないため、定石とされるCSS対策を適用した上で
  「実機でも確認してほしい」と明示的に伝えている
- 見た目の変更はブラウザプレビュー環境で確認してからpushしている。
  スクリーンショットが不安定な時は`getComputedStyle`等JS経由の数値検証で代替
- ユーザーは要望を箇条書きでまとめて渡し、実装からGitHubへの反映まで
  一気に任せるスタイルを好む。大きな設計判断が必要な時だけ確認する
- ユーザーは実機で使ってみて気になった点をスクリーンショット付きで
  都度フィードバックしてくるスタイル。1メッセージに複数の指摘が
  まとまっていることが多く、番号や画像の順番で対応付けて一つずつ処理する
