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
      const adminUrl = new URL(result.adminUrl, location.origin).href;
      document.querySelector("#status").innerHTML = `${
        message("投票ページを発行しました！")
      }<label>投票URL</label><input readonly value="${
        escapeHtml(voteUrl)
      }"><div class="actions"><button type="button" data-copy="${
        escapeHtml(voteUrl)
      }">URLをコピー</button><a class="button secondary" href="${
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
    const voted = localStorage.getItem(`simple-vote-voted-${id}`);
    app.innerHTML = `<p class="eyebrow">Your vote</p><h1>${
      escapeHtml(poll.title)
    }</h1><p class="lead">最も良いと思った作品をひとつ選んでください。</p><section class="card" id="vote-card">${
      voted
        ? message("このブラウザからは投票済みです")
        : `<h2>投票先を選択</h2>${
          poll.options.map((o, i) =>
            `<button class="option" data-id="${escapeHtml(o.id)}"><span>${i + 1}</span>${
              escapeHtml(o.label)
            }</button>`
          ).join("")
        }`
    }</section>`;
    document.querySelectorAll(".option").forEach((button) =>
      button.addEventListener("click", async () => {
        if (!confirm(`「${button.textContent.trim().replace(/^\d+/, "")}」に投票しますか？`)) {
          return;
        }
        document.querySelectorAll(".option").forEach((x) => x.disabled = true);
        try {
          await api(`/api/polls/${id}/vote`, {
            method: "POST",
            body: JSON.stringify({ optionId: button.dataset.id, browserId: getBrowserId() }),
          });
          localStorage.setItem(`simple-vote-voted-${id}`, "1");
          document.querySelector("#vote-card").innerHTML = `<h2>投票ありがとうございました！</h2>${
            message("あなたの一票を受け付けました。")
          }`;
        } catch (e) {
          document.querySelector("#vote-card").insertAdjacentHTML(
            "beforeend",
            message(e.message, true),
          );
        }
      })
    );
  } catch (e) {
    app.innerHTML = message(e.message, true);
  }
}

async function renderAdmin(id) {
  const token = new URLSearchParams(location.search).get("token") || "";
  let editing = false;
  const load = async () => {
    try {
      const poll = await api(`/api/polls/${id}/results`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const max = Math.max(1, ...poll.options.map((o) => o.votes));
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
      }<button id="refresh">集計を更新</button></section><section class="card"><h2>投票内容を編集</h2><form id="poll-settings"><label for="admin-title">投票タイトル</label><input id="admin-title" maxlength="100" required value="${
        escapeHtml(poll.title)
      }">${
        poll.options.map((o, i) =>
          `<label for="admin-option-${i}">選択肢 ${
            i + 1
          }</label><input id="admin-option-${i}" name="admin-option" maxlength="100" required value="${
            escapeHtml(o.label)
          }">`
        ).join("")
      }<button>変更を保存</button></form><div id="status"></div></section>`;
      document.querySelector("#poll-settings").addEventListener("input", () => editing = true);
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
      document.querySelector("#refresh").onclick = load;
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
else if (parts[0] === "admin" && parts[1]) renderAdmin(parts[1]);
else renderHome();
