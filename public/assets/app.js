const app = document.querySelector("#app");
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>'"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char],
  );
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "通信に失敗しました");
  return data;
};
const getBrowserId = () => {
  let id = localStorage.getItem("simple-vote-browser-id");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("simple-vote-browser-id", id);
  }
  return id;
};
const message = (text, error = false) =>
  `<div class="notice ${error ? "error" : ""}">${escapeHtml(text)}</div>`;
const exportJson = (data, prefix) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  link.href = url;
  link.download = `${prefix}-${timestamp}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

function renderHome() {
  app.innerHTML =
    `<p class="eyebrow">Hackathon audience award</p><h1>みんなの一票を<br>その場で。</h1><p class="lead">選択肢を入力するだけで投票ページを発行。集計はリアルタイムに確認できます。</p><section class="card"><h2>投票をつくる</h2><form id="create"><label for="title">投票タイトル</label><input id="title" maxlength="100" required value="オーディエンス賞"><label for="count">選択肢の数</label><select id="count">${
      Array.from({ length: 19 }, (_, i) =>
        `<option value="${i + 2}" ${i === 2 ? "selected" : ""}>${i + 2}件</option>`).join("")
    }</select><div id="choices"></div><button>投票ページを発行</button></form><div id="status"></div></section>`;
  const count = document.querySelector("#count");
  const draw = () =>
    document.querySelector("#choices").innerHTML = Array.from(
      { length: Number(count.value) },
      (_, i) =>
        `<label for="option-${i}">選択肢 ${
          i + 1
        }</label><input id="option-${i}" name="option" maxlength="100" required placeholder="チーム名・作品名">`,
    ).join("");
  count.addEventListener("change", draw);
  draw();
  document.querySelector("#create").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    button.disabled = true;
    try {
      const result = await api("/api/polls", {
        method: "POST",
        body: JSON.stringify({
          title: document.querySelector("#title").value,
          options: [...document.querySelectorAll('[name="option"]')].map((x) => x.value),
        }),
      });
      const voteUrl = new URL(result.voteUrl, location.origin).href;
      const resultUrl = new URL(result.resultUrl, location.origin).href;
      const adminUrl = new URL(result.adminUrl, location.origin).href;
      document.querySelector("#status").innerHTML = `${
        message("投票ページを発行しました！")
      }<label>投票URL</label><input readonly value="${
        escapeHtml(voteUrl)
      }"><label>投票結果URL</label><input readonly value="${
        escapeHtml(resultUrl)
      }"><div class="actions"><button type="button" data-copy="${
        escapeHtml(voteUrl)
      }">URLをコピー</button><a class="button secondary" href="${
        escapeHtml(resultUrl)
      }">投票結果を見る</a><a class="button secondary" href="${
        escapeHtml(adminUrl)
      }">集計・編集画面を見る</a></div><p>管理URLは再発行できないため、大切に保存してください。</p>`;
      document.querySelector("[data-copy]").onclick = async (e) => {
        await navigator.clipboard.writeText(e.currentTarget.dataset.copy);
        e.currentTarget.textContent = "コピーしました";
      };
    } catch (e) {
      document.querySelector("#status").innerHTML = message(e.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

async function renderVote(id) {
  try {
    const poll = await api(`/api/polls/${id}`);
    const voteStorageKey = `simple-vote-voted-${id}-${poll.revision}`;
    const voted = localStorage.getItem(voteStorageKey);
    app.innerHTML = `<p class="eyebrow">Your vote</p><h1>${
      escapeHtml(poll.title)
    }</h1><p class="lead">各チームへコメントを送れます。最後に投票先をひとつ選んでください。</p><div class="team-list">${
      poll.options.map((o, i) =>
        `<section class="card team-card"><div class="team-heading"><span class="team-number">${
          i + 1
        }</span><h2>${escapeHtml(o.label)}</h2></div><form class="comment-form" data-option-id="${
          escapeHtml(o.id)
        }"><label for="comment-${
          escapeHtml(o.id)
        }">このチームに一言コメント</label><textarea id="comment-${
          escapeHtml(o.id)
        }" name="comment" maxlength="200" required placeholder="応援メッセージや感想を入力"></textarea><div class="comment-actions"><span class="comment-status" aria-live="polite"></span><button type="submit" class="secondary">コメントを送信</button></div></form></section>`
      ).join("")
    }</div><section class="card vote-card" id="vote-card"><h2>投票先を選択</h2>${
      voted
        ? message("このブラウザからは投票済みです")
        : `<form id="vote-form"><label for="vote-option">投票するチーム</label><select id="vote-option" name="option" required><option value="">チームを選択してください</option>${
          poll.options.map((o) =>
            `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)}</option>`
          ).join("")
        }</select><button>投票する</button></form>`
    }</section>`;
    document.querySelectorAll(".comment-form").forEach((commentForm) => {
      commentForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = event.submitter;
        const status = form.querySelector(".comment-status");
        const textarea = form.querySelector('[name="comment"]');
        button.disabled = true;
        status.textContent = "";
        status.classList.remove("is-error");
        try {
          await api(`/api/polls/${id}/comments`, {
            method: "POST",
            body: JSON.stringify({
              optionId: form.dataset.optionId,
              browserId: getBrowserId(),
              comment: textarea.value,
            }),
          });
          status.textContent = "送信しました";
          button.textContent = "コメントを更新";
        } catch (e) {
          status.textContent = e.message;
          status.classList.add("is-error");
        } finally {
          button.disabled = false;
        }
      });
    });
    document.querySelector("#vote-form")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = event.submitter;
      button.disabled = true;
      const form = new FormData(event.currentTarget);
      try {
        await api(`/api/polls/${id}/vote`, {
          method: "POST",
          body: JSON.stringify({
            optionId: form.get("option"),
            browserId: getBrowserId(),
          }),
        });
        localStorage.setItem(voteStorageKey, "1");
        document.querySelector("#vote-card").innerHTML = `<h2>投票ありがとうございました！</h2>${
          message("あなたの一票を受け付けました。")
        }`;
      } catch (e) {
        document.querySelector("#vote-card").insertAdjacentHTML(
          "beforeend",
          message(e.message, true),
        );
        button.disabled = false;
      }
    });
    setInterval(async () => {
      try {
        const latestPoll = await api(`/api/polls/${id}`);
        if (latestPoll.revision !== poll.revision) location.reload();
      } catch {
        // Keep the current page visible during temporary connection failures.
      }
    }, 5000);
  } catch (e) {
    app.innerHTML = message(e.message, true);
  }
}

async function renderResult(id) {
  let selectedCommentOption = "";
  const load = async () => {
    try {
      const poll = await api(`/api/polls/${id}/public-results`);
      const max = Math.max(1, ...poll.options.map((o) => o.votes));
      app.innerHTML = `<p class="eyebrow">Vote results</p><h1>${
        escapeHtml(poll.title)
      }</h1><p class="lead">現在の集計・合計 ${poll.totalVotes} 票</p><section class="card results-card"><h2>現在の集計</h2>${
        poll.options.map((o) =>
          `<div class="result"><div class="result-head"><span>${
            escapeHtml(o.label)
          }</span><span>${o.votes}票</span></div><div class="bar"><i style="width:${
            o.votes / max * 100
          }%"></i></div></div>`
        ).join("")
      }</section><section class="card"><h2>チームへのコメント</h2><label for="result-comment-filter">表示するチーム</label><select id="result-comment-filter"><option value="">全部</option>${
        poll.options.map((o) =>
          `<option value="${escapeHtml(o.id)}" ${
            selectedCommentOption === o.id ? "selected" : ""
          }>${escapeHtml(o.label)}</option>`
        ).join("")
      }</select><div class="vote-logs">${
        poll.comments.length
          ? [...poll.comments].reverse().map((log) =>
            `<article class="vote-log" data-option-id="${
              escapeHtml(log.optionId)
            }"><div class="vote-log-head"><strong>${
              escapeHtml(log.optionLabel)
            }</strong><div class="log-meta"><code title="ユーザー識別ID">${
              escapeHtml(log.userId || "--------")
            }</code><time>${
              escapeHtml(new Date(log.timestamp).toLocaleString("ja-JP"))
            }</time></div></div><p>${escapeHtml(log.comment)}</p></article>`
          ).join("")
          : '<p class="muted">まだコメントはありません。</p>'
      }</div></section><p class="result-updated">集計は5秒ごとに自動更新されます</p><div class="page-actions"><button id="export-public-results" class="secondary" type="button">JSONをエクスポート</button></div>`;
      const filter = document.querySelector("#result-comment-filter");
      document.querySelector("#export-public-results").addEventListener(
        "click",
        () => exportJson(poll, `vote-result-${poll.id}`),
      );
      const applyCommentFilter = () => {
        document.querySelectorAll(".vote-log[data-option-id]").forEach((log) => {
          log.hidden = Boolean(selectedCommentOption) &&
            log.dataset.optionId !== selectedCommentOption;
        });
      };
      filter.addEventListener("change", () => {
        selectedCommentOption = filter.value;
        applyCommentFilter();
      });
      applyCommentFilter();
    } catch (e) {
      app.innerHTML = message(e.message, true);
    }
  };
  await load();
  setInterval(load, 5000);
}

async function renderAdmin(id) {
  const token = new URLSearchParams(location.search).get("token") || "";
  let editing = false;
  let selectedCommentOption = "";
  const load = async () => {
    try {
      const poll = await api(`/api/polls/${id}/results`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const max = Math.max(1, ...poll.options.map((o) => o.votes));
      const voteUrl = new URL(`/vote/${encodeURIComponent(id)}`, location.origin).href;
      const resultUrl = new URL(`/result/${encodeURIComponent(id)}`, location.origin).href;
      app.innerHTML = `<p class="eyebrow">Live results</p><h1>${
        escapeHtml(poll.title)
      }</h1><p class="lead">合計 ${poll.totalVotes} 票</p><section class="card results-card"><h2>現在の集計</h2>${
        poll.options.map((o) =>
          `<div class="result"><div class="result-head"><span>${
            escapeHtml(o.label)
          }</span><span>${o.votes}票</span></div><div class="bar"><i style="width:${
            o.votes / max * 100
          }%"></i></div></div>`
        ).join("")
      }<div class="actions"><button id="refresh">集計を更新</button><button id="reset" class="danger">投票をリセット</button></div></section><section class="card"><h2>投票ログ</h2><div class="vote-logs">${
        poll.logs.length
          ? [...poll.logs].reverse().map((log) =>
            `<article class="vote-log"><div class="vote-log-head"><strong>${
              escapeHtml(log.optionLabel)
            }</strong><div class="log-meta"><code title="ユーザー識別ID">${
              escapeHtml(log.userId || "--------")
            }</code><time>${
              escapeHtml(new Date(log.timestamp).toLocaleString("ja-JP"))
            }</time></div></div>${log.comment ? `<p>${escapeHtml(log.comment)}</p>` : ""}</article>`
          ).join("")
          : '<p class="muted">まだ投票はありません。</p>'
      }</div></section><section class="card"><h2>チームへのコメント</h2><label for="admin-comment-filter">表示するチーム</label><select id="admin-comment-filter"><option value="">全部</option>${
        poll.options.map((o) =>
          `<option value="${escapeHtml(o.id)}" ${
            selectedCommentOption === o.id ? "selected" : ""
          }>${escapeHtml(o.label)}</option>`
        ).join("")
      }</select><div class="vote-logs">${
        poll.comments.length
          ? [...poll.comments].reverse().map((log) =>
            `<article class="vote-log" data-comment-option-id="${
              escapeHtml(log.optionId)
            }"><div class="vote-log-head"><strong>${
              escapeHtml(log.optionLabel)
            }</strong><div class="log-meta"><code title="ユーザー識別ID">${
              escapeHtml(log.userId || "--------")
            }</code><time>${
              escapeHtml(new Date(log.timestamp).toLocaleString("ja-JP"))
            }</time></div></div><p>${escapeHtml(log.comment)}</p></article>`
          ).join("")
          : '<p class="muted">まだコメントはありません。</p>'
      }</div></section><section class="card"><h2>公開ページ</h2><label for="vote-url">投票URL</label><input id="vote-url" readonly value="${
        escapeHtml(voteUrl)
      }"><button id="copy-vote-url" type="button">URLをコピー</button><label for="result-url">投票結果URL</label><input id="result-url" readonly value="${
        escapeHtml(resultUrl)
      }"><a class="button secondary" href="${
        escapeHtml(resultUrl)
      }">投票結果を見る</a></section><section class="card"><h2>投票内容を編集</h2><form id="poll-settings"><label for="admin-title">投票タイトル</label><input id="admin-title" maxlength="100" required value="${
        escapeHtml(poll.title)
      }">${
        poll.options.map((o, i) =>
          `<label for="admin-option-${i}">選択肢 ${
            i + 1
          }</label><input id="admin-option-${i}" name="admin-option" maxlength="100" required value="${
            escapeHtml(o.label)
          }">`
        ).join("")
      }<button>変更を保存</button></form><div id="status"></div></section><div class="page-actions"><button id="export-admin-results" class="secondary" type="button">JSONをエクスポート</button></div>`;
      document.querySelector("#poll-settings").addEventListener("input", () => editing = true);
      document.querySelector("#export-admin-results").addEventListener(
        "click",
        () => exportJson(poll, `vote-admin-result-${poll.id}`),
      );
      const commentFilter = document.querySelector("#admin-comment-filter");
      const applyCommentFilter = () => {
        document.querySelectorAll(".vote-log[data-comment-option-id]").forEach((log) => {
          log.hidden = Boolean(selectedCommentOption) &&
            log.dataset.commentOptionId !== selectedCommentOption;
        });
      };
      commentFilter.addEventListener("change", () => {
        selectedCommentOption = commentFilter.value;
        applyCommentFilter();
      });
      applyCommentFilter();
      document.querySelector("#poll-settings").addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = event.submitter;
        button.disabled = true;
        try {
          await api(`/api/polls/${id}`, {
            method: "PATCH",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({
              title: document.querySelector("#admin-title").value,
              options: [...document.querySelectorAll('[name="admin-option"]')].map((input) =>
                input.value
              ),
            }),
          });
          editing = false;
          await load();
          document.querySelector("#status").innerHTML = message("投票内容を変更しました");
        } catch (e) {
          document.querySelector("#status").innerHTML = message(e.message, true);
          button.disabled = false;
        }
      });
      document.querySelector("#copy-vote-url").onclick = async (event) => {
        await navigator.clipboard.writeText(voteUrl);
        event.currentTarget.textContent = "コピーしました";
      };
      document.querySelector("#refresh").onclick = load;
      document.querySelector("#reset").onclick = async () => {
        if (!confirm("すべての票を0に戻します。リセットしてもよろしいですか？")) return;
        editing = true;
        document.querySelector("#reset").disabled = true;
        try {
          await api(`/api/polls/${id}/reset`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
          });
          editing = false;
          await load();
        } catch (e) {
          editing = false;
          app.insertAdjacentHTML("afterbegin", message(e.message, true));
        }
      };
    } catch (e) {
      app.innerHTML = message(e.message, true);
    }
  };
  await load();
  setInterval(() => {
    if (!editing) load();
  }, 5000);
}

const parts = location.pathname.split("/").filter(Boolean);
if (parts[0] === "vote" && parts[1]) renderVote(parts[1]);
else if (parts[0] === "result" && parts[1]) renderResult(parts[1]);
else if (parts[0] === "admin" && parts[1]) renderAdmin(parts[1]);
else renderHome();
