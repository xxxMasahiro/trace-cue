const screen = document.querySelector("#screen");
const main = document.querySelector("#main-content");
const dialog = document.querySelector("#send-dialog");
const toast = document.querySelector("#toast");

const validScreens = new Set(["home", "new", "progress", "result", "finding", "running", "settings"]);
const query = new URLSearchParams(window.location.search);

const state = {
  screen: validScreens.has(query.get("screen")) ? query.get("screen") : "home",
  method: "standard",
  decision: null,
  aiSuggestions: true,
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
      return `<li class="${className}"><span class="step-number">${mark}</span><span class="step-label">${label}</span></li>`;
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
      </div>
    </section>
  </section>`;
}

function renderNew() {
  screen.innerHTML = `<section class="screen narrow" data-mock-screen="new" data-testid="mock-new-review">
    ${pageHeader("新しく確認", `<button class="button text" type="button" data-action="home">閉じる</button>`)}
    ${stepper(1)}
    <form id="review-form">
      <section class="form-section" aria-labelledby="target-title">
        <h2 id="target-title">何を確認しますか</h2>
        <label class="field">WebサイトのURL
          <small>確認したいページを入力します。</small>
          <input class="text-control" name="url" type="url" value="https://www.digital.go.jp/" aria-label="WebサイトのURL" required />
        </label>
        <label class="field">特に何を確かめますか
          <small>知りたいことを普段の言葉で入力できます。</small>
          <input class="text-control" name="purpose" value="初めての人が迷わず使えるか" aria-label="特に何を確かめますか" required />
        </label>
      </section>
      <section class="form-section" aria-labelledby="method-title">
        <h2 id="method-title">どんな結果が必要ですか</h2>
        <div class="method-options">
          ${Object.entries(methods).map(([id, method]) => `<label class="method-option${state.method === id ? " is-selected" : ""}">
            <input type="radio" name="method" value="${id}" ${state.method === id ? "checked" : ""} />
            <span class="radio-mark" aria-hidden="true"></span>
            <span class="method-copy"><strong>${method.title}${method.recommended ? `<span class="recommend">おすすめ</span>` : ""}</strong><span>${method.description}</span></span>
          </label>`).join("")}
        </div>
      </section>
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
          <button class="decision-choice${state.decision === "fix" ? " is-selected" : ""}" type="button" data-decision="fix">修正する</button>
          <button class="decision-choice${state.decision === "later" ? " is-selected" : ""}" type="button" data-decision="later">今回は見送る</button>
          <button class="decision-choice${state.decision === "ask" ? " is-selected" : ""}" type="button" data-decision="ask">相談して決める</button>
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
        ${settingSelect("Playwright Testモード", "自動テスト結果の使い方を選びます。", "今は使わない", ["今は使わない", "保存済みの結果を使う", "このパソコンの結果を使う", "CIの結果を使う"])}
      </section>
      <section class="settings-group" aria-labelledby="ai-settings">
        <h2 id="ai-settings">AIとプライバシー</h2>
        ${settingToggle("AIの提案を使う", "改善案を分かりやすく整理します。", "ai-suggestions", state.aiSuggestions, false)}
        ${settingToggle("外部へ送る前に確認する", "送信先と内容を毎回表示します。この保護はオフにできません。", "send-confirmation", true, true)}
      </section>
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

function setActiveNav() {
  const active = state.screen === "settings" ? "settings" : state.screen === "running" || state.screen === "progress" ? "running" : "home";
  document.querySelectorAll("[data-route]").forEach((button) => button.classList.toggle("is-active", button.dataset.route === active));
}

function render() {
  const renderers = {
    home: renderHome,
    new: renderNew,
    progress: renderProgress,
    result: renderResult,
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
  if (action === "open-finding") navigate("finding");
  if (action === "close-send") dialog.close();
  if (action === "confirm-send") {
    dialog.close();
    navigate("progress");
  }
  if (action === "show-evidence") showToast("画面内の位置と確認結果を表示します");
  if (action === "decision-complete") {
    navigate("result");
    showToast("対応方針を保存しました");
  }
});

document.addEventListener("submit", (event) => {
  event.preventDefault();
  if (event.target.id === "review-form") dialog.showModal();
  if (event.target.id === "settings-form") showToast("設定を保存しました");
});

render();
