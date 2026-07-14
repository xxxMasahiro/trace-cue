const screen = document.querySelector("#screen");
const main = document.querySelector("#main-content");
const dialog = document.querySelector("#send-dialog");
const aiSetupDialog = document.querySelector("#ai-setup-dialog");
const toast = document.querySelector("#toast");

const validScreens = new Set(["home", "new", "progress", "recovery", "result", "intake-result", "finding", "running", "settings"]);
const query = new URLSearchParams(window.location.search);

const state = {
  screen: validScreens.has(query.get("screen")) ? query.get("screen") : "home",
  method: "standard",
  source: query.get("source") || "website",
  decision: null,
  aiSuggestions: true,
  aiEditorOpen: query.get("ai") === "change",
  aiDetailsOpen: query.get("ai") === "change",
  aiDraftEffort: query.get("effort") || "medium",
  aiAppliedEffort: "medium",
  aiActionStatus: "",
  aiConnected: query.get("ai") !== "setup-required",
  aiConnectionKind: query.get("connection") === "api" ? "api" : "subscription",
  aiSetupView: query.get("setup") || "choose",
  settingsSaved: query.get("saved") === "1",
};

const methods = {
  standard: {
    title: "大切な改善点を知りたい",
    description: "重要な点に絞って、次に直すことを分かりやすく示します。",
    recommended: true,
  },
  deep: {
    title: "改善点を詳しく洗い出したい",
    description: "使いやすさや内容を、複数の視点で詳しく確認します。",
  },
  xhigh: {
    title: "重要な判断の前に念入りに確かめたい",
    description: "見直しを重ね、重要な見落としをできるだけ減らします。",
  },
};

const sources = {
  website: { icon: "◎", title: "Webサイト", description: "ブラウザでページを確認します。" },
  image: { icon: "▣", title: "画像", description: "画像の証拠を準備します。" },
  document_text: { icon: "≡", title: "資料", description: "文章から確認案を準備します。" },
  playwright_result: { icon: "✓", title: "テスト結果", description: "保存済みの確認結果を整理します。" },
};

function pageHeader(title, action = "") {
  return `<header class="page-header"><h1>${title}</h1>${action}</header>`;
}

function stepper(current) {
  const steps = ["準備", "確認", "判断", "再確認", "完了"];
  return `<ol class="stepper" aria-label="確認の進み具合">
    ${steps.map((label, index) => {
      const number = index + 1;
      const className = number < current ? "step is-done" : number === current ? "step is-current" : "step";
      const mark = number < current ? "✓" : number;
      return `<li class="${className}" ${number === current ? 'aria-current="step"' : ''}><span class="step-number">${mark}</span><span class="step-label">${label}</span></li>`;
    }).join("")}
  </ol>`;
}

function renderHome() {
  screen.innerHTML = `<section class="screen" data-mock-screen="home" data-testid="mock-home">
    ${pageHeader("確認", `<button class="button primary" type="button" data-action="new-review">＋ 新しく確認</button>`)}
    <section class="next-action" aria-labelledby="next-action-title">
      <div>
        <p class="eyebrow">次にすること</p>
        <h2 id="next-action-title">前回の改善点を確認してください</h2>
        <p>3件の改善点について、対応方針を決められます。</p>
      </div>
      <button class="button primary" type="button" data-action="open-result">結果を見る</button>
    </section>
    <div class="summary-strip" aria-label="確認の概要">
      <div class="metric"><span>対応を決める</span><strong>3件</strong></div>
      <div class="metric"><span>確認中</span><strong>1件</strong></div>
      <div class="metric"><span>完了</span><strong>8件</strong></div>
    </div>
    <section aria-labelledby="recent-title">
      <div class="section-heading"><h2 id="recent-title">最近の確認</h2></div>
      <div class="review-list">
        <button class="review-row" type="button" data-action="open-result">
          <span class="review-copy"><strong>デジタル庁サイト</strong><span>初めての人が迷わず使えるか</span></span>
          <span class="status amber">判断待ち</span>
        </button>
        <button class="review-row" type="button" data-action="open-progress">
          <span class="review-copy"><strong>サービス紹介ページ</strong><span>内容が分かりやすく伝わるか</span></span>
          <span class="status">確認中</span>
        </button>
        <button class="review-row" type="button" data-action="open-result">
          <span class="review-copy"><strong>申込み画面</strong><span>安心して手続きを完了できるか</span></span>
          <span class="status green">完了</span>
        </button>
        <button class="review-row" type="button" data-action="open-intake-result">
          <span class="review-copy"><strong>自動テスト結果</strong><span>時間切れになった確認があります</span></span>
          <span class="status red">対応が必要</span>
        </button>
      </div>
    </section>
  </section>`;
}

function renderNew() {
  const needsReviewGoal = state.source === "website" || state.source === "document_text";
  const aiIdentity = currentAiIdentity();
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="new" data-testid="mock-new-review">
    ${pageHeader("新しく確認", `<button class="button text" type="button" data-action="home">閉じる</button>`)}
    ${state.source === "website" ? stepper(1) : ""}
    <form id="review-form">
      <section class="form-section" aria-labelledby="target-title">
        <h2 id="target-title">何を確認しますか</h2>
        <div class="source-options">
          ${Object.entries(sources).map(([id, source]) => `<label class="source-option${state.source === id ? " is-selected" : ""}">
            <input type="radio" name="source" value="${id}" ${state.source === id ? "checked" : ""} />
            <span class="source-mark" aria-hidden="true">${source.icon}</span>
            <span><strong>${source.title}</strong><small>${source.description}</small></span>
          </label>`).join("")}
        </div>
        ${state.source === "website" ? `<label class="field">WebサイトのURL
          <small>確認したいページを入力します。</small>
          <input class="text-control" name="url" type="url" value="https://www.digital.go.jp/" aria-label="WebサイトのURL" required />
        </label>` : `<label class="file-drop">＋ <span><strong>ファイルを選ぶ</strong><small>ここへ置くこともできます。</small></span><input class="visually-hidden" type="file" aria-label="確認するファイル" required /></label><p class="field-note">ファイルはこのパソコン内に保たれ、保存場所は画面に表示されません。</p>`}
        ${needsReviewGoal ? `<label class="field">特に何を確かめますか
          <small>知りたいことを普段の言葉で入力できます。</small>
          <input class="text-control" name="purpose" value="初めての人が迷わず使えるか" aria-label="特に何を確かめますか" required />
        </label>` : ""}
      </section>
      ${state.source === "website" && state.aiConnected ? `<section class="ai-review-choice" aria-label="利用するAI">
        <div><strong>AIからの提案</strong><p>${aiIdentity.name} · ${aiIdentity.model}</p></div>
        <button class="button text" type="button" data-action="toggle-new-ai" aria-expanded="${state.aiEditorOpen}">変更</button>
        ${state.aiEditorOpen ? `<div class="ai-connection-editor"><details class="ai-details" open><summary>AIの詳細</summary><label>AIの考え方の深さ<select id="mock-new-ai-effort" class="select-control" aria-label="AIの考え方の深さ"><option value="low"${state.aiDraftEffort === "low" ? " selected" : ""}>Low</option><option value="medium"${state.aiDraftEffort === "medium" ? " selected" : ""}>Medium · おすすめ</option><option value="high"${state.aiDraftEffort === "high" ? " selected" : ""}>High</option><option value="xhigh"${state.aiDraftEffort === "xhigh" ? " selected" : ""}>Xhigh</option><option value="max"${state.aiDraftEffort === "max" ? " selected" : ""}>Max</option></select><small>TraceCueの確認方法とは別の設定です。</small></label></details></div>` : ""}
      </section>` : state.source === "website" ? `<section class="ai-setup-needed" aria-label="AIの準備">
        <div><strong>AIの準備が必要です</strong><p>AIからの提案を使えるようにします。</p></div>
        <div class="compact-actions"><button class="button primary compact" type="button" data-action="open-ai-setup">AIを使えるようにする</button><label class="local-choice"><input type="checkbox" />AIを使わずに続ける</label></div>
      </section>` : ''}
      ${needsReviewGoal ? `<section class="form-section" aria-labelledby="method-title">
        <h2 id="method-title">どんな結果が必要ですか</h2>
        <div class="method-options">
          ${Object.entries(methods).map(([id, method]) => `<label class="method-option${state.method === id ? " is-selected" : ""}">
            <input type="radio" name="method" value="${id}" ${state.method === id ? "checked" : ""} />
            <span class="radio-mark" aria-hidden="true"></span>
            <span class="method-copy"><strong>${method.title}${method.recommended ? `<span class="recommend">おすすめ</span>` : ""}</strong><span>${method.description}</span></span>
          </label>`).join("")}
        </div>
      </section>` : ""}
      <div class="form-footer">
        <button class="button secondary" type="button" data-action="home">戻る</button>
        <button class="button primary" type="submit">確認を始める</button>
      </div>
    </form>
  </section>`;

  if (query.get("dialog") === "send") {
    window.requestAnimationFrame(() => dialog.showModal());
  }
}

function renderRecovery() {
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="recovery" data-testid="mock-recovery">
    ${pageHeader("準備を再開", `<button class="button text" type="button" data-action="home">一覧へ戻る</button>`)}
    ${stepper(1)}
    <section class="recovery-panel">
      <p class="eyebrow">次にすること</p>
      <h2>確認の準備が中断しました</h2>
      <p>確認内容は保存されています。このパソコン内の準備だけを安全に再開できます。</p>
      <button class="button primary" type="button" data-action="open-progress">準備を再開</button>
    </section>
  </section>`;
}

function renderProgress() {
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="progress" data-testid="mock-progress">
    ${pageHeader("確認中", `<button class="button text" type="button" data-action="home">一覧へ戻る</button>`)}
    ${stepper(2)}
    <div class="progress-panel">
      <div class="progress-mark" aria-hidden="true">↻</div>
      <h2>複数の視点で詳しく確認しています</h2>
      <p class="muted">この画面を閉じても確認は続きます。</p>
      <div class="progress-tasks">
        <div class="progress-task done"><span class="task-mark">✓</span><span>画面を読み込みました</span></div>
        <div class="progress-task done"><span class="task-mark">✓</span><span>使いやすさを確認しました</span></div>
        <div class="progress-task current"><span class="task-mark">↻</span><span>内容の分かりやすさを確認しています</span></div>
        <div class="progress-task"><span class="task-mark">4</span><span>改善点をまとめます</span></div>
      </div>
      <button class="button secondary" type="button" data-action="open-result">結果画面の見本を見る</button>
    </div>
  </section>`;
}

function renderResult() {
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="result" data-testid="mock-result">
    ${pageHeader("確認結果", `<button class="button text" type="button" data-action="home">一覧へ戻る</button>`)}
    ${stepper(3)}
    <section class="result-summary">
      <p class="eyebrow">確認が終わりました</p>
      <h2>先に対応したい改善点が3件あります</h2>
      <p>重要な順に並べています。上から対応方針を決めてください。</p>
    </section>
    <section aria-labelledby="result-list-title">
      <div class="section-heading"><h2 id="result-list-title">改善点</h2></div>
      <ol class="result-list">
        <li class="result-row"><span class="result-number">1</span><span class="result-copy"><strong>申込みボタンを見つけにくい</strong><span>次に何をすればよいか迷う可能性があります。</span></span><button class="button secondary" type="button" data-action="open-finding">確認する</button></li>
        <li class="result-row"><span class="result-number">2</span><span class="result-copy"><strong>入力エラーの直し方が分かりにくい</strong><span>間違いがある場所を探す必要があります。</span></span><button class="button secondary" type="button" data-action="open-finding">確認する</button></li>
        <li class="result-row"><span class="result-number">3</span><span class="result-copy"><strong>スマートフォンで説明文が小さい</strong><span>大切な説明を読み飛ばす可能性があります。</span></span><button class="button secondary" type="button" data-action="open-finding">確認する</button></li>
      </ol>
    </section>
  </section>`;
}

function renderIntakeResult() {
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="intake-result" data-testid="mock-intake-result">
    <button class="button text back-action" type="button" data-action="home"><span aria-hidden="true">←</span>一覧へ戻る</button>
    <header class="page-header result-page-header"><div><p class="eyebrow">結果の内容</p><h1>保存した結果</h1></div></header>
    <section class="inline-notice danger" role="alert">
      <strong>通らなかった自動確認があります</strong>
      <p>1件中、失敗が0件、時間切れが1件です。0件は通りました。</p>
    </section>
    <dl class="result-facts">
      <div><dt>確認したもの</dt><dd>テスト結果</dd></div>
      <div><dt>保存日時</dt><dd>2026年7月13日 10:30</dd></div>
      <div><dt>確認した件数</dt><dd>1</dd></div>
      <div><dt>通った件数</dt><dd>0</dd></div>
      <div><dt>失敗した件数</dt><dd>0</dd></div>
      <div><dt>時間切れの件数</dt><dd>1</dd></div>
      <div><dt>実行しなかった件数</dt><dd>0</dd></div>
    </dl>
  </section>`;
}

function renderFinding() {
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="finding" data-testid="mock-finding">
    ${pageHeader("改善点を確認", `<button class="button text" type="button" data-action="open-result">結果へ戻る</button>`)}
    ${stepper(3)}
    <div class="finding-layout">
      <article class="finding-copy">
        <p class="finding-number">改善点 1 / 3</p>
        <h2>申込みボタンを見つけにくい</h2>
        <p>利用者が次に何をすればよいか迷い、手続きを途中でやめる可能性があります。</p>
        <div class="recommendation"><strong>おすすめの対応</strong><p>申込みボタンを最初の画面内へ移動し、説明の直後に表示します。</p></div>
        <button class="button text" type="button" data-action="show-evidence">この判断の理由を見る</button>
      </article>
      <aside class="decision-panel" aria-labelledby="decision-title">
        <h3 id="decision-title">どうしますか</h3>
        <div class="decision-actions">
          <button class="decision-choice${state.decision === "fix" ? " is-selected" : ""}" type="button" aria-pressed="${state.decision === "fix"}" data-decision="fix">修正する</button>
          <button class="decision-choice${state.decision === "later" ? " is-selected" : ""}" type="button" aria-pressed="${state.decision === "later"}" data-decision="later">今回は見送る</button>
          <button class="decision-choice${state.decision === "ask" ? " is-selected" : ""}" type="button" aria-pressed="${state.decision === "ask"}" data-decision="ask">相談して決める</button>
        </div>
      </aside>
    </div>
    <div class="form-footer"><button class="button primary" type="button" data-action="decision-complete">この方針で進める</button></div>
  </section>`;
}

function renderRunning() {
  screen.innerHTML = `<section class="screen" data-mock-screen="running" data-testid="mock-running">
    ${pageHeader("進行中")}
    <div class="review-list">
      <button class="review-row" type="button" data-action="open-progress">
        <span class="review-copy"><strong>サービス紹介ページ</strong><span>内容の分かりやすさを確認しています</span></span>
        <span class="status">確認中</span>
      </button>
    </div>
  </section>`;
}

function renderSettings() {
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="settings" data-testid="mock-settings">
    ${pageHeader("設定")}
    <form id="settings-form">
      <section class="settings-group" aria-labelledby="everyday-settings">
        <h2 id="everyday-settings">普段の使い方</h2>
        ${settingSelect("表示する言葉", "画面で使う言語です。", "日本語", ["日本語", "English"])}
        ${settingSelect("いつも確認する画面", "新しい確認で最初に選ばれます。", "両方", ["両方", "パソコン", "スマートフォン"])}
        ${settingSelect("自動確認", "保存した確認結果の使い方を選びます。", "今は使わない", ["今は使わない", "保存済みの結果を使う", "このパソコンの結果を使う", "承認済みの共有結果を使う"])}
      </section>
      <section class="settings-group" aria-labelledby="ai-settings">
        <h2 id="ai-settings">AIとプライバシー</h2>
        ${settingToggle("AIの提案を使う", "改善案を分かりやすく整理します。", "ai-suggestions", state.aiSuggestions, false)}
        ${settingAiService()}
        ${settingToggle("外部へ送る前に確認する", "送信先と内容を毎回表示します。この保護はオフにできません。", "send-confirmation", true, true)}
      </section>
      ${state.settingsSaved ? '<div class="inline-notice success" role="status"><strong>設定を保存しました</strong></div>' : ''}
      <div class="settings-footer"><button class="button primary" type="submit">設定を保存</button></div>
    </form>
  </section>`;
}

function settingSelect(title, description, current, choices) {
  return `<div class="setting-row"><div class="setting-copy"><strong>${title}</strong><span>${description}</span></div><div class="setting-control"><select class="select-control" aria-label="${title}">${choices.map((choice) => `<option${choice === current ? " selected" : ""}>${choice}</option>`).join("")}</select></div></div>`;
}

function settingToggle(title, description, id, checked, locked) {
  return `<div class="setting-row"><div class="setting-copy"><strong>${title}</strong><span>${description}</span></div><div>${locked ? `<span class="locked-note">✓ 常に確認</span>` : `<label class="toggle" aria-label="${title}"><input id="${id}" type="checkbox" ${checked ? "checked" : ""} /><span class="toggle-track"></span></label>`}</div></div>`;
}

function settingAiService() {
  const aiIdentity = currentAiIdentity();
  const effortNames = { low: "Low", medium: "Medium", high: "High", xhigh: "Xhigh", max: "Max" };
  const effortOptions = Object.entries(effortNames).map(([value, label]) => `<option value="${value}"${state.aiDraftEffort === value ? " selected" : ""}>${label}${value === "medium" ? " · おすすめ" : ""}</option>`).join("");
  const editor = state.aiEditorOpen ? `<div class="ai-connection-editor">
    <details class="ai-details"${state.aiDetailsOpen ? " open" : ""}>
      <summary>AIの詳細</summary>
      <label>AIの考え方の深さ<select id="mock-ai-effort" class="select-control" aria-label="AIの考え方の深さ">${effortOptions}</select><small>TraceCueの確認方法とは別の設定です。</small></label>
    </details>
    ${state.aiDraftEffort !== state.aiAppliedEffort ? '<button class="button primary compact" type="button" data-action="apply-ai">このAIを使う</button>' : ""}
    ${state.aiActionStatus ? `<p class="ai-action-status" role="status">${state.aiActionStatus}</p>` : ""}
  </div>` : "";
  const connection = state.aiConnected
    ? `<div class="ai-connection-summary"><span class="ai-status">利用できます</span><span class="ai-connection-name"><strong>${aiIdentity.name}</strong><small>${aiIdentity.model}</small></span></div>`
    : `<div class="ai-connection-summary"><span class="ai-status needs-setup">準備が必要</span></div>`;
  return `<div class="setting-row ai-setting-row"><div class="setting-copy"><strong>利用するAI</strong><span>改善提案に利用するAIを選びます。</span></div><div class="ai-connection-setting">${connection}<div class="compact-actions">${state.aiConnected ? `<button class="button text" type="button" data-action="toggle-ai" aria-expanded="${state.aiEditorOpen}">変更</button>` : ""}<button class="button ${state.aiConnected ? "secondary" : "primary"} compact" type="button" data-action="open-ai-setup">${state.aiConnected ? "接続を変更" : "AIを使えるようにする"}</button><button class="button secondary compact" type="button" data-action="refresh-ai">利用状況を更新</button></div>${state.aiConnected ? editor : ""}</div></div>`;
}

function renderAiSetupDialog() {
  const aiIdentity = currentAiIdentity();
  const currentActions = state.aiConnectionKind === "api"
    ? '<div class="ai-setup-current-actions"><button class="button text" type="button" data-action="show-api-setup">APIキーを変更</button><button class="button text" type="button" data-action="disconnect-ai">接続を解除</button></div>'
    : '';
  const current = state.aiConnected ? `<div class="ai-setup-current"><span aria-hidden="true">✓</span><div><strong>接続済み</strong><p>${aiIdentity.name}</p></div>${currentActions}</div>` : "";
  const subscriptionChoice = !state.aiConnected || state.aiConnectionKind !== "subscription"
    ? '<button class="ai-service-choice" type="button" data-action="show-subscription-setup"><span class="ai-service-mark" aria-hidden="true">C</span><span><strong>Codex</strong><small>サブスクリプションで使う</small></span><span class="recommend">おすすめ</span><span aria-hidden="true">›</span></button>'
    : '';
  const apiChoice = !state.aiConnected || state.aiConnectionKind !== "api"
    ? '<details class="ai-setup-alternative"><summary>別の方法を使う</summary><button class="ai-service-choice" type="button" data-action="show-api-setup"><span class="ai-service-mark" aria-hidden="true">A</span><span><strong>OpenAI</strong><small>APIキーで接続</small></span><span aria-hidden="true">›</span></button></details>'
    : '';
  const choose = `<p class="ai-setup-intro">普段お使いのサービスを選んでください。</p>
    ${current}
    ${subscriptionChoice}
    ${apiChoice}`;
  const subscription = `<div class="ai-setup-step" aria-live="polite"><p>サインインページを開き、このコードを入力してください。</p><output class="device-code" aria-label="一時コード">ABCD-EFGH</output><a class="button primary full-width" href="https://auth.openai.com/codex/device" target="_blank" rel="noreferrer">サインインページを開く ↗</a><p class="field-note">サインイン後、この画面は自動で続きます。</p><div class="dialog-actions"><button class="button secondary" type="button" data-action="stop-ai-sign-in">サインインを中止</button></div></div>`;
  const api = `<form class="ai-setup-step" id="mock-ai-api-form"><p>AIサービスで発行したAPIキーを入力してください。</p><label class="field">APIキー<input class="text-control" id="mock-api-key" type="password" autocomplete="off" required minlength="8" aria-label="APIキー" /></label><p class="field-note">このコントロールセンターの起動中だけ使います。ブラウザやプロジェクトには保存しません。</p><div class="dialog-actions"><button class="button secondary" type="button" data-action="back-ai-setup">戻る</button><button class="button primary" type="submit">接続する</button></div></form>`;
  aiSetupDialog.innerHTML = `<button class="dialog-close" type="button" data-action="close-ai-setup" aria-label="閉じる">×</button><p class="eyebrow">AIの提案</p><h2 id="ai-setup-title" tabindex="-1">AIを使えるようにする</h2>${state.aiSetupView === "api" ? api : state.aiSetupView === "subscription" ? subscription : choose}`;
}

function currentAiIdentity() {
  return state.aiConnectionKind === "api"
    ? { name: "OpenAI", model: "GPT-5.6 Sol" }
    : { name: "Codex", model: "GPT-5.6 Sol" };
}

function openAiSetup(view = "choose") {
  state.aiSetupView = view;
  renderAiSetupDialog();
  if (!aiSetupDialog.open) aiSetupDialog.showModal();
  window.requestAnimationFrame(() => aiSetupDialog.querySelector("#ai-setup-title")?.focus());
}

function setActiveNav() {
  const active = state.screen === "settings" ? "settings" : state.screen === "running" || state.screen === "progress" ? "running" : "home";
  document.querySelectorAll("[data-route]").forEach((button) => button.classList.toggle("is-active", button.dataset.route === active));
}

function render() {
  const renderers = {
    home: renderHome,
    new: renderNew,
    progress: renderProgress,
    recovery: renderRecovery,
    result: renderResult,
    "intake-result": renderIntakeResult,
    finding: renderFinding,
    running: renderRunning,
    settings: renderSettings,
  };
  renderers[state.screen]();
  setActiveNav();
  document.title = `TraceCue - ${state.screen === "settings" ? "設定" : state.screen === "running" || state.screen === "progress" ? "進行中" : "確認"}`;
  main.focus({ preventScroll: true });
}

function navigate(next) {
  state.screen = next;
  const url = new URL(window.location.href);
  url.search = "";
  url.searchParams.set("screen", next);
  window.history.replaceState({}, "", url);
  render();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("is-visible"), 1800);
}

document.addEventListener("click", (event) => {
  const route = event.target.closest("[data-route]");
  if (route) {
    navigate(route.dataset.route);
    return;
  }

  const method = event.target.closest(".method-option");
  if (method) {
    state.method = method.querySelector("input").value;
    renderNew();
    return;
  }

  const source = event.target.closest(".source-option");
  if (source) {
    state.source = source.querySelector("input").value;
    renderNew();
    return;
  }

  const decision = event.target.closest("[data-decision]");
  if (decision) {
    state.decision = decision.dataset.decision;
    renderFinding();
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;
  if (action === "new-review") navigate("new");
  if (action === "home") navigate("home");
  if (action === "open-progress") navigate("progress");
  if (action === "open-result") navigate("result");
  if (action === "open-intake-result") navigate("intake-result");
  if (action === "open-finding") navigate("finding");
  if (action === "close-send") dialog.close();
  if (action === "open-ai-setup") openAiSetup("choose");
  if (action === "close-ai-setup") aiSetupDialog.close();
  if (action === "show-api-setup") openAiSetup("api");
  if (action === "show-subscription-setup") openAiSetup("subscription");
  if (action === "back-ai-setup" || action === "stop-ai-sign-in") openAiSetup("choose");
  if (action === "disconnect-ai") {
    state.aiConnected = false;
    openAiSetup("choose");
  }
  if (action === "confirm-send") {
    dialog.close();
    navigate("progress");
  }
  if (action === "show-evidence") showToast("画面内の位置と確認結果を表示します");
  if (action === "toggle-ai") {
    state.aiEditorOpen = !state.aiEditorOpen;
    state.aiActionStatus = "";
    renderSettings();
  }
  if (action === "toggle-new-ai") {
    state.aiEditorOpen = !state.aiEditorOpen;
    renderNew();
  }
  if (action === "refresh-ai") showToast("利用できるAIを確認しました");
  if (action === "apply-ai") {
    state.aiAppliedEffort = state.aiDraftEffort;
    state.aiActionStatus = "利用するAIを変更しました。";
    renderSettings();
  }
  if (action === "decision-complete") {
    navigate("result");
    showToast("対応方針を保存しました");
  }
});

document.addEventListener("change", (event) => {
  if (event.target.id === "mock-new-ai-effort") {
    state.aiDraftEffort = event.target.value;
    renderNew();
    return;
  }
  if (event.target.id !== "mock-ai-effort") return;
  state.aiDraftEffort = event.target.value;
  state.aiDetailsOpen = true;
  state.aiActionStatus = "";
  renderSettings();
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "review-form") {
    if (state.source === "website") dialog.showModal();
    else showToast(state.source === "image" ? "画像の証拠を準備しました" : state.source === "document_text" ? "確認案を準備しました" : "テスト結果を整理しました");
  }
  if (event.target.id === "settings-form") {
    state.settingsSaved = true;
    const url = new URL(window.location.href);
    url.searchParams.set("saved", "1");
    window.history.replaceState({}, "", url);
    renderSettings();
  }
  if (event.target.id === "mock-ai-api-form") {
    state.aiConnected = true;
    state.aiConnectionKind = "api";
    state.aiSetupView = "choose";
    event.target.reset();
    aiSetupDialog.close();
    const url = new URL(window.location.href);
    url.searchParams.delete("dialog");
    url.searchParams.delete("setup");
    url.searchParams.delete("ai");
    window.history.replaceState({}, "", url);
    if (state.screen === "new") renderNew();
    if (state.screen === "settings") renderSettings();
    showToast("AIを使えるようにしました");
  }
});

render();
if (query.get("dialog") === "ai-setup") {
  window.requestAnimationFrame(() => openAiSetup(state.aiSetupView));
}
