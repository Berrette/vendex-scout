const DB_NAME = "vendex-scout-db";
const DB_VERSION = 2;
const STORE = "clients";
const TILE_SIZE = 256;

const STATUSES = ["Новый лид", "КП отправлено", "Думает", "Переговоры", "Текущий клиент", "Пауза", "Отказ"];
const ACTIONS = ["Позвонить", "Написать WhatsApp", "Отправить КП", "Дожать", "Проверить оплату", "Назначить встречу", "Сервисный контакт"];
const ACTIVE_STATUSES = new Set(["Новый лид", "КП отправлено", "Думает", "Переговоры"]);

const state = {
  clients: [],
  query: "",
  view: "today",
  draftTimeline: [],
  draftPhotos: [],
  installPrompt: null,
  map: {
    center: { lat: 55.7558, lng: 37.6176 },
    zoom: 11,
    dragging: false,
    dragStart: null,
    centerStart: null
  }
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const els = {
  screenTitle: $("#screenTitle"),
  search: $("#searchInput"),
  dailyBrief: $("#dailyBrief"),
  today: $("#todayList"),
  list: $("#clientList"),
  pipeline: $("#pipelineBoard"),
  map: $("#map"),
  statDue: $("#statDue"),
  statHot: $("#statHot"),
  statPipeline: $("#statPipeline"),
  statBackup: $("#statBackup"),
  clientDialog: $("#clientDialog"),
  dataDialog: $("#dataDialog"),
  form: $("#clientForm"),
  toast: $("#toast"),
  installButton: $("#installButton"),
  deleteButton: $("#deleteClientButton"),
  suggestion: $("#messageSuggestion"),
  timelineEditor: $("#timelineEditor"),
  photoPreview: $("#photoPreview"),
  backupNotice: $("#backupNotice")
};

let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("nextContact", "nextContact");
        store.createIndex("status", "status");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    const result = action(store);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
}

async function getAllClients() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result.map(normalizeClient).sort(sortClients));
    request.onerror = () => reject(request.error);
  });
}

async function saveClient(client) {
  await tx("readwrite", (store) => store.put(normalizeClient(client)));
  await refresh();
}

async function deleteClient(id) {
  await tx("readwrite", (store) => store.delete(id));
  await refresh();
}

function normalizeClient(client) {
  const timeline = Array.isArray(client.timeline) ? client.timeline : [];
  if (!timeline.length && client.notes) {
    timeline.push({
      id: crypto.randomUUID(),
      date: client.updatedAt?.slice(0, 10) || todayIso(),
      type: "Заметка",
      text: client.notes
    });
  }
  return {
    id: client.id || crypto.randomUUID(),
    createdAt: client.createdAt || new Date().toISOString(),
    updatedAt: client.updatedAt || new Date().toISOString(),
    name: client.name || "",
    contact: client.contact || "",
    phone: client.phone || "",
    email: client.email || "",
    status: STATUSES.includes(client.status) ? client.status : "Новый лид",
    heat: client.heat || "Теплый",
    nextAction: client.nextAction || "Позвонить",
    nextContact: client.nextContact || "",
    offerDate: client.offerDate || "",
    offerAmount: client.offerAmount || "",
    offerProduct: client.offerProduct || "",
    offerLink: client.offerLink || "",
    offerComment: client.offerComment || "",
    placeType: client.placeType || "Не указано",
    potential: client.potential || "Не оценен",
    traffic: client.traffic || "",
    competitors: client.competitors || "",
    address: client.address || "",
    lat: client.lat ?? "",
    lng: client.lng ?? "",
    timeline,
    photos: Array.isArray(client.photos) ? client.photos : []
  };
}

function sortClients(a, b) {
  const dueSort = (a.nextContact || "9999-12-31").localeCompare(b.nextContact || "9999-12-31");
  if (dueSort) return dueSort;
  const heatSort = heatScore(b.heat) - heatScore(a.heat);
  if (heatSort) return heatSort;
  return a.name.localeCompare(b.name, "ru");
}

function heatScore(heat) {
  return { "Горячий": 3, "Теплый": 2, "Холодный": 1 }[heat] || 0;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return "не указано";
  return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" }).format(new Date(`${value}T12:00:00`));
}

function formatMoney(value) {
  const amount = Number(String(value || "").replace(",", "."));
  if (!Number.isFinite(amount) || amount <= 0) return "";
  return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(amount) + " ₽";
}

function offerSummary(client) {
  const money = formatMoney(client.offerAmount);
  const date = client.offerDate ? formatDate(client.offerDate) : "";
  if (date && money) return `КП: ${date} · ${money}`;
  if (date) return `КП: ${date}`;
  if (money) return `КП: ${money}`;
  return "КП: нет";
}

function daysSince(dateValue) {
  if (!dateValue) return null;
  const start = new Date(`${dateValue}T12:00:00`);
  const now = new Date(`${todayIso()}T12:00:00`);
  return Math.floor((now - start) / 86400000);
}

function dueState(client) {
  if (!client.nextContact) return "";
  if (client.nextContact < todayIso()) return "late";
  if (client.nextContact === todayIso()) return "due";
  return "";
}

function isDue(client) {
  return client.nextContact && client.nextContact <= todayIso();
}

function matchesQuery(client) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  return [
    client.name,
    client.contact,
    client.phone,
    client.email,
    client.status,
    client.heat,
    client.nextAction,
    client.offerProduct,
    client.offerComment,
    client.placeType,
    client.potential,
    client.traffic,
    client.competitors,
    client.address,
    ...client.timeline.map((item) => `${item.type} ${item.text}`)
  ].filter(Boolean).join(" ").toLowerCase().includes(q);
}

function filteredClients() {
  return state.clients.filter(matchesQuery);
}

function render() {
  const clients = filteredClients();
  renderStats();
  renderDailyBrief(clients);
  renderList(els.today, clients.filter(isDue), "На сегодня контактов нет. Можно открыть воронку и выбрать горячих без следующего шага.");
  renderList(els.list, clients, "Пока нет клиентов. Нажмите «Клиент», чтобы добавить первую карточку.");
  renderPipeline(clients);
  renderMap();
}

function renderStats() {
  const due = state.clients.filter(isDue).length;
  const hot = state.clients.filter((client) => client.heat === "Горячий" && client.status !== "Отказ").length;
  const active = state.clients.filter((client) => ACTIVE_STATUSES.has(client.status)).length;
  els.statDue.textContent = due;
  els.statHot.textContent = hot;
  els.statPipeline.textContent = active;
  els.statBackup.textContent = backupAgeLabel();
  renderBackupNotice();
}

function backupAgeLabel() {
  const last = localStorage.getItem("vendex:lastBackupAt");
  if (!last) return "нет";
  const diff = Math.max(0, Math.floor((Date.now() - new Date(last).getTime()) / 86400000));
  return diff === 0 ? "сегодня" : `${diff} дн.`;
}

function renderBackupNotice() {
  const last = localStorage.getItem("vendex:lastBackupAt");
  const text = last
    ? `Последний экспорт: ${new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(last))}.`
    : "Экспорт еще не делали. Лучше скачать базу после первых реальных клиентов.";
  els.backupNotice.textContent = text;
}

function renderDailyBrief(clients) {
  const due = clients.filter(isDue);
  const late = due.filter((client) => dueState(client) === "late").length;
  const staleOffers = clients.filter((client) => client.status === "КП отправлено" && daysSince(client.offerDate) >= 3);
  const noNext = clients.filter((client) => ACTIVE_STATUSES.has(client.status) && !client.nextContact);
  els.dailyBrief.innerHTML = `
    <div>
      <b>${due.length}</b>
      <span>контактов сегодня</span>
    </div>
    <div>
      <b>${late}</b>
      <span>просрочено</span>
    </div>
    <div>
      <b>${staleOffers.length}</b>
      <span>КП без ответа 3+ дн.</span>
    </div>
    <div>
      <b>${noNext.length}</b>
      <span>без следующего шага</span>
    </div>
  `;
}

function renderList(container, clients, emptyText) {
  container.innerHTML = "";
  if (!clients.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = emptyText;
    container.append(empty);
    return;
  }

  for (const client of clients) {
    const button = document.createElement("button");
    button.className = "client-card";
    button.type = "button";
    button.addEventListener("click", () => openClient(client));
    button.innerHTML = clientCardHtml(client);
    container.append(button);
  }
}

function clientCardHtml(client) {
  const stateClass = dueState(client);
  const dueLabel = stateClass === "late" ? "Просрочено" : stateClass === "due" ? "Сегодня" : client.status;
  const last = latestTimeline(client);
  return `
    <div class="card-head">
      <div>
        <h3>${escapeHtml(client.name)}</h3>
        <p>${escapeHtml(client.contact || client.address || "Контакт не указан")}</p>
      </div>
      <span class="badge ${stateClass}">${escapeHtml(dueLabel)}</span>
    </div>
    <div class="meta-row">
      <span>${escapeHtml(client.heat)}</span>
      <span>${escapeHtml(client.nextAction)}: ${formatDate(client.nextContact)}</span>
      <span>${escapeHtml(offerSummary(client))}</span>
      <span>${escapeHtml(client.placeType)}</span>
    </div>
    ${last ? `<p>${escapeHtml(last.date)} · ${escapeHtml(last.type)}: ${escapeHtml(last.text).slice(0, 150)}</p>` : ""}
  `;
}

function renderPipeline(clients) {
  els.pipeline.innerHTML = "";
  for (const status of STATUSES) {
    const columnClients = clients.filter((client) => client.status === status);
    const column = document.createElement("section");
    column.className = "pipeline-column";
    column.innerHTML = `<h3>${status}<span>${columnClients.length}</span></h3>`;
    const list = document.createElement("div");
    list.className = "pipeline-list";
    if (!columnClients.length) {
      const empty = document.createElement("p");
      empty.className = "pipeline-empty";
      empty.textContent = "Пусто";
      list.append(empty);
    } else {
      for (const client of columnClients) {
        const card = document.createElement("button");
        card.className = "pipeline-card";
        card.type = "button";
        card.addEventListener("click", () => openClient(client));
        card.innerHTML = `
          <b>${escapeHtml(client.name)}</b>
          <span>${escapeHtml(client.heat)} · ${escapeHtml(client.nextAction)}</span>
          <span>${formatDate(client.nextContact)} · ${escapeHtml(offerSummary(client))}</span>
        `;
        list.append(card);
      }
    }
    column.append(list);
    els.pipeline.append(column);
  }
}

function latestTimeline(client) {
  return [...client.timeline].sort((a, b) => (b.date || "").localeCompare(a.date || ""))[0];
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function switchView(view) {
  state.view = view;
  els.screenTitle.textContent = { today: "Сегодня", pipeline: "Воронка", list: "База", map: "Карта" }[view] || "Вендэкс Scout";
  $$(".content-view").forEach((node) => node.classList.toggle("active", node.id === `${view}View`));
  $$(".segment, .nav-button[data-view]").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  if (view === "map") setTimeout(renderMap, 50);
}

function fillSelect(select, values) {
  select.innerHTML = values.map((value) => `<option>${escapeHtml(value)}</option>`).join("");
}

function openClient(client = null) {
  const normalized = client ? normalizeClient(client) : null;
  els.form.reset();
  state.draftTimeline = normalized ? structuredClone(normalized.timeline) : [newTimelineItem("Звонок", "")];
  state.draftPhotos = normalized ? structuredClone(normalized.photos) : [];

  $("#sheetMode").textContent = normalized ? "Редактирование" : "Новый клиент";
  $("#sheetTitle").textContent = normalized ? normalized.name : "Карточка";
  els.deleteButton.hidden = !normalized;
  $("#clientId").value = normalized?.id || "";
  $("#nameInput").value = normalized?.name || "";
  $("#contactInput").value = normalized?.contact || "";
  $("#phoneInput").value = normalized?.phone || "";
  $("#emailInput").value = normalized?.email || "";
  $("#statusInput").value = normalized?.status || "Новый лид";
  $("#heatInput").value = normalized?.heat || "Теплый";
  $("#nextActionInput").value = normalized?.nextAction || "Позвонить";
  $("#nextContactInput").value = normalized?.nextContact || addDays(3);
  $("#offerDateInput").value = normalized?.offerDate || "";
  $("#offerAmountInput").value = normalized?.offerAmount || "";
  $("#offerProductInput").value = normalized?.offerProduct || "";
  $("#offerLinkInput").value = normalized?.offerLink || "";
  $("#offerCommentInput").value = normalized?.offerComment || "";
  $("#placeTypeInput").value = normalized?.placeType || "Не указано";
  $("#potentialInput").value = normalized?.potential || "Не оценен";
  $("#trafficInput").value = normalized?.traffic || "";
  $("#competitorsInput").value = normalized?.competitors || "";
  $("#addressInput").value = normalized?.address || "";
  $("#latInput").value = normalized?.lat ?? "";
  $("#lngInput").value = normalized?.lng ?? "";
  renderTimelineEditor();
  renderPhotoPreview();
  updateSuggestion();
  els.clientDialog.showModal();
}

function readForm() {
  const existing = state.clients.find((client) => client.id === $("#clientId").value);
  return normalizeClient({
    id: $("#clientId").value || crypto.randomUUID(),
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: $("#nameInput").value.trim(),
    contact: $("#contactInput").value.trim(),
    phone: $("#phoneInput").value.trim(),
    email: $("#emailInput").value.trim(),
    status: $("#statusInput").value,
    heat: $("#heatInput").value,
    nextAction: $("#nextActionInput").value,
    nextContact: $("#nextContactInput").value,
    offerDate: $("#offerDateInput").value,
    offerAmount: $("#offerAmountInput").value.trim(),
    offerProduct: $("#offerProductInput").value.trim(),
    offerLink: $("#offerLinkInput").value.trim(),
    offerComment: $("#offerCommentInput").value.trim(),
    placeType: $("#placeTypeInput").value,
    potential: $("#potentialInput").value,
    traffic: $("#trafficInput").value.trim(),
    competitors: $("#competitorsInput").value.trim(),
    address: $("#addressInput").value.trim(),
    lat: parseFloatOrBlank($("#latInput").value),
    lng: parseFloatOrBlank($("#lngInput").value),
    timeline: readTimelineEditor(),
    photos: state.draftPhotos
  });
}

function parseFloatOrBlank(value) {
  const normalized = String(value || "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : "";
}

function newTimelineItem(type = "Звонок", text = "") {
  return { id: crypto.randomUUID(), date: todayIso(), type, text };
}

function renderTimelineEditor() {
  els.timelineEditor.innerHTML = "";
  for (const item of state.draftTimeline) {
    const row = document.createElement("div");
    row.className = "timeline-edit";
    row.dataset.id = item.id;
    row.innerHTML = `
      <input type="date" value="${escapeHtml(item.date || todayIso())}" data-field="date">
      <select data-field="type">
        ${["Звонок", "WhatsApp", "Email", "КП", "Встреча", "Договоренность", "Сервис", "Заметка"].map((type) =>
          `<option ${type === item.type ? "selected" : ""}>${type}</option>`
        ).join("")}
      </select>
      <textarea rows="2" data-field="text" placeholder="Что произошло и о чем договорились">${escapeHtml(item.text || "")}</textarea>
      <button type="button" class="danger-button small-button" data-remove-timeline="${item.id}">Удалить</button>
    `;
    els.timelineEditor.append(row);
  }
}

function readTimelineEditor() {
  return [...els.timelineEditor.querySelectorAll(".timeline-edit")].map((row) => ({
    id: row.dataset.id,
    date: row.querySelector('[data-field="date"]').value,
    type: row.querySelector('[data-field="type"]').value,
    text: row.querySelector('[data-field="text"]').value.trim()
  })).filter((item) => item.text || item.type !== "Заметка");
}

function renderPhotoPreview() {
  els.photoPreview.innerHTML = "";
  if (!state.draftPhotos.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Фото пока нет. Можно добавить фасад, место под аппарат или конкурентов.";
    els.photoPreview.append(empty);
    return;
  }
  for (const photo of state.draftPhotos) {
    const wrap = document.createElement("div");
    wrap.className = "photo-item";
    wrap.innerHTML = `
      <img src="${photo.dataUrl}" alt="${escapeHtml(photo.name || "Фото точки")}">
      <button type="button" class="danger-button small-button" data-remove-photo="${photo.id}">Удалить</button>
    `;
    els.photoPreview.append(wrap);
  }
}

async function addPhotos(files) {
  const selected = [...files].slice(0, 6);
  for (const file of selected) {
    const dataUrl = await fileToDataUrl(file);
    state.draftPhotos.push({ id: crypto.randomUUID(), name: file.name, dataUrl });
  }
  renderPhotoPreview();
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function makeSuggestion(client = readForm()) {
  const firstName = client.contact ? client.contact.split(/[,\s]/)[0] : "";
  const hello = firstName ? `${firstName}, добрый день!` : "Добрый день!";
  const place = client.placeType && client.placeType !== "Не указано" ? client.placeType.toLowerCase() : "вашей точки";
  const potential = client.potential && client.potential !== "Не оценен" ? ` Потенциал вижу как ${client.potential.toLowerCase()}:` : "";
  const traffic = client.traffic ? ` ${client.traffic}.` : "";
  const competitors = client.competitors ? ` Также учту текущую ситуацию: ${client.competitors}.` : "";
  const product = client.offerProduct ? ` по ${client.offerProduct}` : "";
  const templates = {
    first: `${hello} Меня зовут Данил, Вендэкс. Мы ставим и обслуживаем вендинговые точки: кофе, снеки и сопутствующий ассортимент под трафик площадки. Хотел обсудить, подойдет ли формат для ${place}.${potential}${traffic}${competitors} Если интересно, предложу вариант размещения и короткое КП.`,
    afterOffer: `${hello} Хотел уточнить, получилось ли посмотреть КП Вендэкс${product}. Могу отдельно пройтись по экономике точки, условиям установки, обслуживанию и ассортименту. Если все ок, предлагаю согласовать следующий шаг: осмотр места или финальные условия.`,
    softPing: `${hello} Возвращаюсь к вопросу по вендингу. Правильно понимаю, что установка автомата для ${place} еще актуальна? Если да, могу быстро сверить трафик, место подключения и подготовить понятный вариант запуска.`,
    paused: `${hello} Ранее обсуждали вендинг от Вендэкс, но поставили вопрос на паузу. Сейчас могу обновить условия и прикинуть вариант под вашу площадку: формат автомата, ассортимент, обслуживание и сроки установки.`,
    current: `${hello} Хочу сверить, как сейчас работает точка Вендэкс: хватает ли ассортимента, есть ли замечания по сервису, пополнению или оплате. Если есть идеи по улучшению или второй точке, давайте зафиксируем и запланируем следующий шаг.`
  };
  return templates[$("#templateInput").value] || templates.first;
}

function updateSuggestion() {
  els.suggestion.textContent = makeSuggestion();
}

async function refresh() {
  state.clients = await getAllClients();
  render();
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("visible");
  setTimeout(() => els.toast.classList.remove("visible"), 2200);
}

async function geocodeAddress() {
  const address = $("#addressInput").value.trim();
  if (!address) {
    showToast("Введите адрес");
    return;
  }
  const cacheKey = `geocode:${address.toLowerCase()}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    setCoords(JSON.parse(cached));
    showToast("Координаты взяты из кэша");
    return;
  }
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "1");
    url.searchParams.set("q", address);
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("geocode failed");
    const [place] = await response.json();
    if (!place) {
      showToast("Адрес не найден");
      return;
    }
    localStorage.setItem(cacheKey, JSON.stringify(place));
    setCoords(place);
    showToast("Координаты найдены");
  } catch {
    showToast("Геокодинг сейчас недоступен");
  }
}

function setCoords(place) {
  $("#latInput").value = Number(place.lat).toFixed(6);
  $("#lngInput").value = Number(place.lon).toFixed(6);
}

function project(lat, lng, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  };
}

function unproject(x, y, zoom) {
  const scale = TILE_SIZE * 2 ** zoom;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}

function renderMap() {
  if (!els.map || state.view !== "map") return;
  const width = els.map.clientWidth || 360;
  const height = els.map.clientHeight || 420;
  els.map.innerHTML = "";

  const centerPx = project(state.map.center.lat, state.map.center.lng, state.map.zoom);
  const topLeft = { x: centerPx.x - width / 2, y: centerPx.y - height / 2 };
  const startX = Math.floor(topLeft.x / TILE_SIZE);
  const endX = Math.floor((topLeft.x + width) / TILE_SIZE);
  const startY = Math.floor(topLeft.y / TILE_SIZE);
  const endY = Math.floor((topLeft.y + height) / TILE_SIZE);
  const max = 2 ** state.map.zoom;

  for (let x = startX; x <= endX; x += 1) {
    for (let y = startY; y <= endY; y += 1) {
      if (y < 0 || y >= max) continue;
      const img = document.createElement("img");
      img.className = "tile";
      img.draggable = false;
      img.alt = "";
      const wrappedX = ((x % max) + max) % max;
      img.src = `https://tile.openstreetmap.org/${state.map.zoom}/${wrappedX}/${y}.png`;
      img.style.left = `${x * TILE_SIZE - topLeft.x}px`;
      img.style.top = `${y * TILE_SIZE - topLeft.y}px`;
      els.map.append(img);
    }
  }

  const withCoords = filteredClients().filter((client) => Number.isFinite(Number(client.lat)) && Number.isFinite(Number(client.lng)));
  for (const client of withCoords) {
    const point = project(Number(client.lat), Number(client.lng), state.map.zoom);
    const left = point.x - topLeft.x;
    const top = point.y - topLeft.y;
    if (left < -40 || left > width + 40 || top < -40 || top > height + 60) continue;
    const marker = document.createElement("button");
    marker.className = `marker ${client.status === "Текущий клиент" ? "current" : ""} heat-${heatScore(client.heat)}`;
    marker.title = client.name;
    marker.style.left = `${left}px`;
    marker.style.top = `${top}px`;
    marker.addEventListener("click", () => openClient(client));
    els.map.append(marker);

    const label = document.createElement("div");
    label.className = "map-label";
    label.textContent = client.name;
    label.style.left = `${left}px`;
    label.style.top = `${top}px`;
    els.map.append(label);
  }

  const controls = document.createElement("div");
  controls.className = "zoom-controls";
  controls.innerHTML = '<button type="button" aria-label="Увеличить">+</button><button type="button" aria-label="Уменьшить">−</button>';
  controls.children[0].addEventListener("click", () => zoomMap(1));
  controls.children[1].addEventListener("click", () => zoomMap(-1));
  els.map.append(controls);
}

function zoomMap(delta) {
  state.map.zoom = Math.max(3, Math.min(18, state.map.zoom + delta));
  renderMap();
}

function fitMapToClients() {
  const points = filteredClients().filter((client) => Number.isFinite(Number(client.lat)) && Number.isFinite(Number(client.lng)));
  if (!points.length) {
    showToast("Нет клиентов с координатами");
    return;
  }
  const lats = points.map((client) => Number(client.lat));
  const lngs = points.map((client) => Number(client.lng));
  state.map.center = {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2
  };
  state.map.zoom = points.length === 1 ? 14 : 11;
  renderMap();
}

function locateMe() {
  if (!navigator.geolocation) {
    showToast("Геолокация недоступна");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      state.map.center = { lat: position.coords.latitude, lng: position.coords.longitude };
      state.map.zoom = 14;
      renderMap();
    },
    () => showToast("Не удалось получить позицию"),
    { enableHighAccuracy: true, timeout: 9000 }
  );
}

function bindMapDrag() {
  els.map.addEventListener("pointerdown", (event) => {
    state.map.dragging = true;
    state.map.dragStart = { x: event.clientX, y: event.clientY };
    state.map.centerStart = { ...state.map.center };
    els.map.setPointerCapture(event.pointerId);
  });
  els.map.addEventListener("pointermove", (event) => {
    if (!state.map.dragging) return;
    const startPx = project(state.map.centerStart.lat, state.map.centerStart.lng, state.map.zoom);
    state.map.center = unproject(
      startPx.x - (event.clientX - state.map.dragStart.x),
      startPx.y - (event.clientY - state.map.dragStart.y),
      state.map.zoom
    );
    renderMap();
  });
  els.map.addEventListener("pointerup", () => {
    state.map.dragging = false;
  });
  els.map.addEventListener("pointercancel", () => {
    state.map.dragging = false;
  });
}

function exportData() {
  const payload = { exportedAt: new Date().toISOString(), version: 2, clients: state.clients };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `vendex-scout-${todayIso()}.json`;
  link.click();
  URL.revokeObjectURL(url);
  localStorage.setItem("vendex:lastBackupAt", new Date().toISOString());
  renderStats();
  showToast("Backup скачан");
}

async function importData(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const clients = Array.isArray(payload) ? payload : payload.clients;
    if (!Array.isArray(clients)) throw new Error("bad format");
    await Promise.all(clients.map((client) => saveClient({ ...client, id: client.id || crypto.randomUUID() })));
    showToast("Импорт готов");
    els.dataDialog.close();
  } catch {
    showToast("Не получилось импортировать JSON");
  }
}

async function seedDemo() {
  const demo = [
    {
      name: "БЦ Северный",
      contact: "Алексей, АХО",
      phone: "+7 900 000-00-02",
      email: "alex@example.ru",
      status: "Текущий клиент",
      heat: "Горячий",
      nextAction: "Сервисный контакт",
      nextContact: todayIso(),
      offerAmount: "180000",
      offerProduct: "Вендэкс Office",
      placeType: "Бизнес-центр",
      potential: "Высокий",
      traffic: "450 сотрудников, 2 корпуса",
      competitors: "Кофейня на первом этаже",
      address: "Москва, Ленинградский проспект",
      lat: 55.7835,
      lng: 37.5663,
      timeline: [
        { id: crypto.randomUUID(), date: addDays(-7), type: "Договоренность", text: "Согласовали тестовую точку и список вопросов по сервису." },
        { id: crypto.randomUUID(), date: todayIso(), type: "Сервис", text: "Нужно уточнить остатки и обсудить вторую точку." }
      ]
    },
    {
      name: "Кофе-точка на Тверской",
      contact: "Ирина, управляющая",
      phone: "+7 900 000-00-01",
      email: "irina@example.ru",
      status: "КП отправлено",
      heat: "Теплый",
      nextAction: "Дожать",
      offerDate: addDays(-4),
      nextContact: todayIso(),
      offerAmount: "95000",
      offerProduct: "Вендэкс Start",
      placeType: "ТЦ / ритейл",
      potential: "Средний",
      traffic: "Плотный поток утром и в обед",
      competitors: "Есть кофейня рядом",
      address: "Москва, Тверская улица",
      lat: 55.7648,
      lng: 37.6057,
      timeline: [
        { id: crypto.randomUUID(), date: addDays(-4), type: "КП", text: "Отправлено КП, просили уточнить сроки запуска и сервис." }
      ]
    }
  ];
  await Promise.all(demo.map((client) => saveClient({ ...client, id: crypto.randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })));
  els.dataDialog.close();
  showToast("Демо-клиенты добавлены");
}

function bindEvents() {
  fillSelect($("#statusInput"), STATUSES);
  fillSelect($("#nextActionInput"), ACTIONS);

  els.search.addEventListener("input", () => {
    state.query = els.search.value;
    render();
  });
  $$(".segment, .nav-button[data-view]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  $("#addClientButton").addEventListener("click", () => openClient());
  $("#dataButton").addEventListener("click", () => els.dataDialog.showModal());
  $$("[data-close-dialog]").forEach((button) => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });
  ["statusInput", "contactInput", "nameInput", "offerProductInput", "placeTypeInput", "templateInput"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updateSuggestion);
  });
  $("#copySuggestionButton").addEventListener("click", async () => {
    await navigator.clipboard.writeText(els.suggestion.textContent);
    showToast("Текст скопирован");
  });
  $("#addTimelineButton").addEventListener("click", () => {
    state.draftTimeline.unshift(newTimelineItem());
    renderTimelineEditor();
  });
  els.timelineEditor.addEventListener("click", (event) => {
    const id = event.target.dataset.removeTimeline;
    if (!id) return;
    state.draftTimeline = readTimelineEditor().filter((item) => item.id !== id);
    renderTimelineEditor();
  });
  $("#photoInput").addEventListener("change", (event) => addPhotos(event.target.files));
  els.photoPreview.addEventListener("click", (event) => {
    const id = event.target.dataset.removePhoto;
    if (!id) return;
    state.draftPhotos = state.draftPhotos.filter((photo) => photo.id !== id);
    renderPhotoPreview();
  });
  $("#geocodeButton").addEventListener("click", geocodeAddress);
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const client = readForm();
    if (!client.name) {
      showToast("Введите название клиента");
      return;
    }
    await saveClient(client);
    els.clientDialog.close();
    showToast("Карточка сохранена");
  });
  els.deleteButton.addEventListener("click", async () => {
    const id = $("#clientId").value;
    if (!id || !confirm("Удалить клиента?")) return;
    await deleteClient(id);
    els.clientDialog.close();
    showToast("Клиент удален");
  });
  $("#exportButton").addEventListener("click", exportData);
  $("#importInput").addEventListener("change", (event) => importData(event.target.files[0]));
  $("#seedButton").addEventListener("click", seedDemo);
  $("#fitMapButton").addEventListener("click", fitMapToClients);
  $("#locateButton").addEventListener("click", locateMe);
  window.addEventListener("resize", renderMap);
  bindMapDrag();
}

function registerPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.installPrompt = event;
    els.installButton.hidden = false;
  });
  els.installButton.addEventListener("click", async () => {
    if (!state.installPrompt) return;
    state.installPrompt.prompt();
    await state.installPrompt.userChoice;
    state.installPrompt = null;
    els.installButton.hidden = true;
  });
}

bindEvents();
registerPwa();
refresh();
