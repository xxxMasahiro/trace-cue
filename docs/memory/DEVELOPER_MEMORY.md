# DEVELOPER_MEMORY.md

Developer memory has been reset.

**E. Next Proposal**

次の提案は **AHR Dogfood Evidence-Pack Operations Preflight / Owner Review Worklist Projection** です。

目的は、今回追加した evidence-pack summary を土台にして、実プロバイダ dogfood を再実行する前に「何が揃っているか」「何が不足しているか」「owner 承認が必要なものは何か」「ローカル再生成で済むものは何か」を、非エンジニアにも読める形で安全に出すことです。

xhigh サブエージェント3件の統合結果:
- 採用: operations preflight / owner worklist を追加する。既存の `dogfood evidence-pack summarize`、`claim standard-gate`、`evidence-set regenerate plan`、source-text owner context を再利用する。
- 採用: 先に CLI/API/schema parity を固める。command name、runner export、schema name、help、package discovery の drift を検出できるテストを強化する。
- 延期: 大きな parser refactor、UI、Markdown proof packet、実プロバイダ自動実行。
- 却下: 既存挙動とのトレードオフ、provider 実行許可の拡張、MCP 露出、artifact 自動書き込み、human-equivalent / human-superior claim の許可。

非スコープ:
- provider/API call
- credential value read
- external transfer
- artifact write
- automatic rerun
- MCP exposure
- claim gate 合格条件変更
- 既存 summary / claim gate / evidence-set output の意味変更

この E 提案で停止します。承認後に **F. Roadmap** として番号付きスライスに分解します。

**F. Roadmap**

承認を受けて、**F. Roadmap** を提示します。まだ実装には入りません。

**Roadmap: 1-8**

1. **Contract Parity Hardening**
   AHR dogfood / evidence-set / claim 系コマンドの CLI/API/schema/help/package 露出を棚卸しし、drift 検出テストを追加する。既存挙動は変更しない。

2. **Preflight Schema Contract**
   `agentic_human_review_dogfood_operations_preflight` の read-only schema を追加する。出力は準備済み、不足、承認必要、再生成候補、case/effort impact を持つ。

3. **Shared Worklist Projector**
   `rerun_plan.targets`、evidence regeneration dependency、source-text freshness invalidation を共通 helper で owner 向け worklist に正規化する。pathless / commandless / proof-neutral を維持する。

4. **CLI/API Surface**
   `agentic review dogfood evidence-pack preflight --input <workspace-json> --json` を追加し、API runner と schema registry に接続する。`--execute`、provider/model/surface 指定は拒否する。

5. **Safe Output Integration**
   既存の evidence-pack summary / claim-standard-gate / evidence-regeneration 出力には意味変更を入れず、必要なら additive な `owner_review_worklist` 投影のみ追加する。

6. **Focused Tests**
   no-browser tests で matrix 不足、owner-baseline contract 不足、comparison/calibration 不足、approval-required/local-only 分類、forged context 再サニタイズ、漏えい抑制を検証する。

7. **Docs And Manifests**
   requirements/spec/security/verification/task tracker/handoff/README/changelog/ops manifests を同期する。実行許可ではなく read-only preflight であることを明記する。

8. **Verification, Commit, CI, Sync**
   `node --check`、focused tests、`npm test`、pack checks、docs/security/structure checks、`product-gate`、`git diff --check` を通し、commit、push、main CI 成功、local/remote sync、clean tree まで完了する。

この F Roadmap で停止します。承認後、`Start: [Roadmap: 1-8]` として A→B→C→D→E→F の順に戻ります。
