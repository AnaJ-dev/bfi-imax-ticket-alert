async function render() {
  const { watchedFilms = [], filmStates = {} } = await chrome.storage.local.get(["watchedFilms", "filmStates"]);

  const anySlot = [];
  const specific = [];
  for (const f of watchedFilms) {
    const times = filmStates[f.permalink]?.notifyDateTimes || [];
    if (times.length === 0) anySlot.push(f);
    else specific.push({ ...f, times: sortByDateTime(times) });
  }

  renderAnySlotList(anySlot);
  renderSpecificList(specific);
}

function renderAnySlotList(films) {
  const el = document.getElementById("anySlotList");
  el.innerHTML = films.length
    ? films
        .map(
          (f) => `<div class="film-row">
            <span class="film-row-title">${escapeHtml(f.title)}</span>
            <button type="button" class="remove-btn" data-permalink="${f.permalink}" data-action="unfollow">Remove</button>
          </div>`
        )
        .join("")
    : '<div class="empty">None</div>';
}

const expandedFilms = new Set();

function renderSpecificList(films) {
  const el = document.getElementById("specificList");
  el.innerHTML = films.length
    ? films
        .map((f) => {
          const expanded = expandedFilms.has(f.permalink);
          return `<div class="specific-film">
            <div class="specific-film-header">
              <button type="button" class="specific-film-toggle" data-permalink="${f.permalink}" data-action="toggle" aria-expanded="${expanded}">
                <span class="caret">${expanded ? "▾" : "▸"}</span>
                <span class="film-row-title">${escapeHtml(f.title)}</span>
                <span class="time-count">${f.times.length} time${f.times.length === 1 ? "" : "s"}</span>
              </button>
              <button type="button" class="remove-btn" data-permalink="${f.permalink}" data-action="unfollow">Remove film</button>
            </div>
            <div class="time-list" ${expanded ? "" : "hidden"}>
              ${f.times
                .map(
                  (dt) => `<div class="time-row">
                    <span>${escapeHtml(formatDateTime(dt))}</span>
                    <button type="button" class="time-remove" data-permalink="${f.permalink}" data-datetime="${dt.replace(
                    /"/g,
                    "&quot;"
                  )}" data-action="remove-time" title="Remove this time">×</button>
                  </div>`
                )
                .join("")}
            </div>
          </div>`;
        })
        .join("")
    : '<div class="empty">None</div>';
}

async function handleRemoveClick(e) {
  const toggleBtn = e.target.closest('[data-action="toggle"]');
  if (toggleBtn) {
    const permalink = toggleBtn.dataset.permalink;
    if (expandedFilms.has(permalink)) expandedFilms.delete(permalink);
    else expandedFilms.add(permalink);
    render();
    return;
  }

  const unfollowBtn = e.target.closest('[data-action="unfollow"]');
  if (unfollowBtn) {
    await chrome.runtime.sendMessage({ type: "REMOVE_WATCH", permalink: unfollowBtn.dataset.permalink });
    return;
  }
  const timeBtn = e.target.closest('[data-action="remove-time"]');
  if (timeBtn) {
    const { filmStates = {} } = await chrome.storage.local.get("filmStates");
    const current = filmStates[timeBtn.dataset.permalink]?.notifyDateTimes || [];
    const updated = current.filter((dt) => dt !== timeBtn.dataset.datetime);
    if (updated.length === 0) {
      await chrome.runtime.sendMessage({ type: "REMOVE_WATCH", permalink: timeBtn.dataset.permalink });
    } else {
      await chrome.runtime.sendMessage({
        type: "SET_NOTIFY_SLOTS",
        permalink: timeBtn.dataset.permalink,
        dateTimes: updated,
      });
    }
  }
}

document.getElementById("anySlotList")?.addEventListener("click", handleRemoveClick);
document.getElementById("specificList")?.addEventListener("click", handleRemoveClick);

document.addEventListener("DOMContentLoaded", render);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.watchedFilms || changes.filmStates)) render();
});
