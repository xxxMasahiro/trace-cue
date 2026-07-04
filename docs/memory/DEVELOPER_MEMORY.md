**実装前原案**

目的は、TraceCue が「要約だけを読んだ薄いレビュー」ではなく、FrameCue の文字起こし全文と TraceCue 既存分析を統合して、自然で内容の濃いレビューを出せるか検証することです。

今回の検証対象は、指定動画のような動画コンテンツですが、設計は動画専用にしません。`video / web_page / pdf / meeting_notes / document` など、全文テキスト化できる成果物すべてに同じ流れを適用します。

**基本方針**

1. FrameCue は動画解析と文字起こし全文の生成を担当する
2. TraceCue は FrameCue の出力を `--source-text` として受け取る
3. TraceCue は全文から `source_reading_review` と `source_understanding_review` を作る
4. 統括担当はその全文理解と、既存の AHR findings / role opinions / recommendations を統合する
5. 最終的に `editorial_synthesis.full_review` に自然なレビュー文を出す
6. `standard / deep / xhigh` の effort 差分が本文品質に反映されるか確認する
7. 私が直接書く参照レビューと並べ、どこが不足しているか評価する

**期待する出力差**

`standard`:
- 内容の方向性が正しい
- 全文の主要論点を押さえる
- 私の直接レビューと概ね同等に読める

`deep`:
- 具体例、読者価値、実用面の整理が増える
- 「何がよいか」「どこに注意すべきか」がより明確
- 私の直接レビューより少し踏み込んでいる

`xhigh`:
- 反論、限界、検証不足、結論が変わる条件まで含む
- 動画の内容理解とレビュー判断が明確に接続される
- 私の直接レビューより詳細で、判断根拠が強い

**PASS条件**

- 要約だけをなぞった本文になっていない
- 文字起こし全文由来の具体的な論点が本文に出る
- `standard / deep / xhigh` の本文が明確に違う
- `xhigh` が単に長いだけでなく、検証・反論・限界・改善方向を含む
- 日本語 artifact output で自然に読める
- TraceCue は raw video / raw audio / raw frame を読まない
- full transcript は result JSON / Markdown に丸ごと保存しない
- provider/API 呼び出しや proof claim は増やさない

**非目標**

- FrameCue 側の実装変更はしない
- YouTube 依存の分岐は作らない
- 動画専用ロジックにはしない
- 「人間同等」「人間以上」とは主張しない
- release gate や deterministic finding は変更しない

**不足時の修正候補**

検証でまだ薄い場合は、次に以下を直します。

1. `source_understanding_review` の抽出密度を上げる
2. 文字起こし全文の重要箇所をより多く拾う
3. 統括担当が全文理解と AHR findings を照合する比重を上げる
4. `xhigh` で反論・検証・限界・結論変更条件を必須化する
5. 最終本文で同じ構文が繰り返される問題を抑える
6. 私の参照レビューとの差分を diagnostic として出す

この原案で進めるなら、次にスライス化したロードマップを提示します。

**ロードマップ**

| Slice | 目的 | 成果物 |
|---:|---|---|
| 0 | 検証境界を固定 | source-text / AHR / editorial synthesis の責務整理 |
| 1 | FrameCue出力の入力形を確認 | 文字起こし全文 artifact の受け取り条件 |
| 2 | 実データ検証パック作成 | 指定動画用の source-text / content evidence / review input |
| 3 | standard 実行 | standard の自然文レビューと品質診断 |
| 4 | deep 実行 | deep の自然文レビューと品質診断 |
| 5 | xhigh 実行 | xhigh の自然文レビューと品質診断 |
| 6 | 私の参照レビュー作成 | 同じ動画を私が直接レビューした比較基準 |
| 7 | effort差分比較 | standard / deep / xhigh / 参照レビューの横並び比較 |
| 8 | 不足診断 | 薄さ、重複、具体性不足、全文理解不足の特定 |
| 9 | 必要なら実装修正 | source-understanding / editorial synthesis / xhigh統括の改善 |
| 10 | 再検証と同期 | テスト、docs同期、コミット、CI、リモート同期 |

**Slice 0: 検証境界を固定**

目的:
- TraceCue が読むのは FrameCue が生成したテキスト artifact。
- TraceCue は raw video / raw audio / raw frame を読まない。
- full transcript は保存・転送しない。
- 最終レビューは advisory-only。

受け入れ条件:
- 動画専用分岐ではなく、汎用 source-text review として扱う
- provider/API追加呼び出しなし
- proof claim / release gate 変更なし

**Slice 1: FrameCue出力の入力形確認**

目的:
- FrameCue の文字起こし全文を TraceCue の `--source-text` で読める形にする。

受け入れ条件:
- `source_type=video`
- transcript full text は入力時だけ読む
- result / Markdown に全文を丸ごと残さない
- chunk/hash/ref だけ保持

**Slice 2: 実データ検証パック作成**

目的:
- 指定動画を対象に、TraceCue 実行に必要な review index / source-text / evidence を揃える。

受け入れ条件:
- 対象URLに依存したコード分岐なし
- artifact は `.browser-debug/` 配下
- secret-like pattern なし

**Slice 3: standard 実行**

目的:
- standard が「私と概ね同等」レベルに近いか確認する。

受け入れ条件:
- 主要論点が抜けていない
- 要約なぞりだけではない
- 日本語として自然に読める
- ただし xhigh 的な厳密検証までは求めない

**Slice 4: deep 実行**

目的:
- deep が standard より具体性、読者価値、改善方向で上回るか確認する。

受け入れ条件:
- concrete examples が増える
- audience value が明確
- 改善優先順位が出る
- standard と本文差分が明確

**Slice 5: xhigh 実行**

目的:
- xhigh が最も強い統括レビューになるか確認する。

受け入れ条件:
- 反論、限界、検証不足、結論変更条件が入る
- source understanding と AHR findings の接続が明確
- 単に長いだけではない
- 私の参照レビューを上回る可能性がある内容になっている

**Slice 6: 私の参照レビュー作成**

目的:
- 比較基準として、私が直接生成する自然なレビューを作る。

受け入れ条件:
- 同じ証拠条件を前提に書く
- 文章品質、具体性、判断根拠を比較可能にする
- TraceCue結果とは別枠で表示

**Slice 7: effort差分比較**

目的:
- standard / deep / xhigh / 私の参照レビューを横並びで比較する。

受け入れ条件:
- 本文差分が見える
- 何が良くなったか、何が足りないかを列挙
- `standard=同等`, `deep=少し上`, `xhigh=凌駕` の目標に対して判定

**Slice 8: 不足診断**

目的:
- TraceCue本文がまだ薄い場合、原因を分類する。

診断軸:
- transcript本文を十分拾えていない
- source_understanding が浅い
- AHR findings との統合が弱い
- editorial synthesis が定型文に寄っている
- xhigh の検証・反論が本文に反映されていない

**Slice 9: 必要なら実装修正**

目的:
- 不足が実装由来なら修正する。

修正候補:
- source-understanding抽出密度を上げる
- narrative plan の材料選択を改善
- xhigh専用の検証・反論・限界統合を強化
- 重複文や定型文を抑制
- multi-source artifact でも同じ処理が使えるように保つ

**Slice 10: 再検証と同期**

目的:
- 修正後に再検証し、成果物を確定する。

受け入れ条件:
- focused test pass
- `npm test` pass
- `product-gate` pass
- docs / test manifest 同期
- commit
- push
- main CI success
- local `HEAD` と `origin/main` 一致
- working tree clean
