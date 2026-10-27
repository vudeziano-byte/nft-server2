// Сервер рынка: каталог, балансы, сделки и пополнение статиками (XTR) для StaticGram. Node.js 18+, без зависимостей.
// Переменные: BOT_TOKEN (обязательно), UPSTASH_URL + UPSTASH_TOKEN (постоянное хранилище, нужно на бесплатном Render), OWNER (по умолчанию marvel)
const http = require("http"), fs = require("fs"), crypto = require("crypto");
const BOT_TOKEN = process.env.BOT_TOKEN, API = process.env.API_BASE || "https://api.staticgram.top", PORT = process.env.PORT || 3000;
const OWNER = (process.env.OWNER || "marvel").toLowerCase().replace("@", "");
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED === "1"; // только для теста!
const UP = process.env.UPSTASH_URL, UT = process.env.UPSTASH_TOKEN;
const RARITY = ["Обычная", "Редкая", "Эпическая", "Легендарная"];

// ---- хранилище: Upstash Redis (если задан) или папка data/ ----
const kv = async cmd => (await (await fetch(UP, { method: "POST", headers: { Authorization: "Bearer " + UT }, body: JSON.stringify(cmd) })).json()).result;
const kvGet = async k => UP ? kv(["GET", k]) : (fs.existsSync("data/" + k) ? fs.readFileSync("data/" + k, "utf8") : null);
const kvSet = async (k, v) => UP ? kv(["SET", k, v]) : (fs.mkdirSync("data", { recursive: true }), fs.writeFileSync("data/" + k, v));
let db = { items: [], deals: [], balances: {}, invoices: {}, charges: {} }, dirty = false;
const imgs = {}, touch = () => { dirty = true; };
setInterval(async () => { if (!dirty) return; dirty = false; try { await kvSet("meta", JSON.stringify(db)); } catch (e) { dirty = true; console.error(e.message); } }, 2000);

const bot = (m, b = {}) => fetch(`${API}/bot${BOT_TOKEN}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());

// ---- кто пользователь: подпись initData (проверка по документации StaticGram) ----
function userOf(b) {
  try {
    const p = new URLSearchParams(b.initData || ""), hash = p.get("hash"); p.delete("hash");
    const chk = [...p.entries()].sort(([a], [c]) => a.localeCompare(c)).map(([k, v]) => `${k}=${v}`).join("\n");
    const sec = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    if (hash && crypto.createHmac("sha256", sec).update(chk).digest("hex") === hash && Date.now() / 1000 - Number(p.get("auth_date")) < 86400) {
      const u = JSON.parse(p.get("user")); return { key: (u.username || "id" + u.id).toLowerCase(), id: String(u.id) };
    }
  } catch (e) {}
  if (ALLOW_UNSIGNED && b.userId) return { key: String(b.username || "id" + b.userId).toLowerCase(), id: String(b.userId) };
  return null;
}
const json = (res, code, o) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(JSON.stringify(o)); };
const readBody = async req => { let raw = ""; for await (const c of req) { raw += c; if (raw.length > 600000) break; } try { return JSON.parse(raw); } catch (e) { return {}; } };
const bal = k => db.balances[k] || 0;
const int = (v, max) => { v = Math.floor(Number(v)); return v >= 1 && v <= max ? v : 0; };
const str = (v, n) => String(v || "").trim().slice(0, n);

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 200, {});
  const url = new URL(req.url, "http://x"), path = url.pathname;
  if (path === "/") return json(res, 200, { ok: true });

  if (req.method === "GET" && path.startsWith("/img/")) {                      // картинки предметов
    const id = path.slice(5).replace(/\W/g, "");
    let d = imgs[id] || (imgs[id] = await kvGet("img_" + id));
    if (!d) return json(res, 404, { ok: false });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=31536000", "Access-Control-Allow-Origin": "*" });
    return res.end(Buffer.from(d.split(",")[1], "base64"));
  }

  const b = req.method === "POST" ? await readBody(req) : Object.fromEntries(url.searchParams);
  const u = userOf(b);
  if (!u) return json(res, 401, { ok: false, error: "Не удалось проверить пользователя" });

  if (path === "/api/state")
    return json(res, 200, { ok: true, balance: bal(u.key), items: db.items.map(i => ({ ...i, img: "/img/" + i.id })), deals: db.deals.filter(d => d.buyer === u.key || d.seller === u.key) });

  if (req.method !== "POST") return json(res, 404, { ok: false });

  if (path === "/api/mint") {                                                  // только владелец
    if (u.key !== OWNER) return json(res, 403, { ok: false, error: "Нет прав" });
    const it = { id: crypto.randomBytes(6).toString("hex"), name: str(b.name, 40), collection: str(b.collection, 40), rarity: b.rarity, number: str(b.number, 10), owner: u.key, price: int(b.price, 1e6) };
    if (!it.name || !it.collection || !it.number || !it.price || !RARITY.includes(it.rarity) || !String(b.img).startsWith("data:image/jpeg;base64,") || b.img.length > 400000) return json(res, 400, { ok: false, error: "Проверьте поля" });
    imgs[it.id] = b.img; await kvSet("img_" + it.id, b.img); db.items.push(it); touch();
    return json(res, 200, { ok: true, msg: "NFT добавлен" });
  }
  const it = db.items.find(i => i.id === b.id);
  if (path === "/api/sell" || path === "/api/unlist") {
    if (!it || it.owner !== u.key) return json(res, 403, { ok: false, error: "Это не ваш предмет" });
    if (path === "/api/sell") { const p = int(b.price, 1e6); if (!p) return json(res, 400, { ok: false, error: "Неверная цена" }); it.price = p; } else it.price = null;
    touch(); return json(res, 200, { ok: true, msg: path === "/api/sell" ? "Выставлено в каталог" : "Снято с продажи" });
  }
  if (path === "/api/buy") {
    if (!it || it.price == null) return json(res, 400, { ok: false, error: "Лот недоступен" });
    if (it.owner === u.key) return json(res, 400, { ok: false, error: "Это ваш лот" });
    if (bal(u.key) < it.price) return json(res, 400, { ok: false, error: "Недостаточно звёзд" });
    db.balances[u.key] = bal(u.key) - it.price; db.balances[it.owner] = bal(it.owner) + it.price;
    db.deals.push({ t: Date.now(), name: `${it.name} #${it.number}`, price: it.price, buyer: u.key, seller: it.owner });
    it.owner = u.key; it.price = null; touch(); return json(res, 200, { ok: true, msg: "Покупка успешна!" });
  }
  if (path === "/api/invoice") {                                               // счёт на пополнение в статиках
    const amount = int(b.amount, 100000); if (!amount) return json(res, 400, { ok: false, error: "Сумма от 1 до 100000" });
    const payload = crypto.randomBytes(12).toString("hex");
    const r = await bot("createInvoiceLink", { title: "Пополнение баланса", description: `Пополнение баланса на ${amount} ⭐`, payload, currency: "XTR", prices: [{ label: "Пополнение", amount }] });
    if (!r.ok) return json(res, 502, { ok: false, error: r.description || "Не удалось создать счёт" });
    db.invoices[payload] = { key: u.key, id: u.id, amount, status: "new" }; touch();
    return json(res, 200, { ok: true, link: r.result });
  }
  json(res, 404, { ok: false });
});

async function poll(offset = 0) {                                              // подтверждение оплаты (long polling)
  try {
    const r = await bot("getUpdates", { offset, timeout: 25, allowed_updates: ["pre_checkout_query", "message"] });
    for (const u of r.result || []) {
      offset = u.update_id + 1; const q = u.pre_checkout_query;
      if (q) { const inv = db.invoices[q.invoice_payload]; const ok = inv && inv.status === "new" && inv.id === String(q.from.id) && q.currency === "XTR" && q.total_amount === inv.amount;
        await bot("answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: "Счёт недействителен" }); }
      const sp = u.message && u.message.successful_payment;
      if (sp) { const inv = db.invoices[sp.invoice_payload], ch = sp.telegram_payment_charge_id;
        if (inv && inv.status === "new" && !db.charges[ch]) { inv.status = "paid"; db.charges[ch] = inv.amount; db.balances[inv.key] = bal(inv.key) + inv.amount; touch(); console.log(`Пополнение: ${inv.key} +${inv.amount}`); } }
    }
  } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
  poll(offset);
}
if (!BOT_TOKEN) { console.error("Задайте BOT_TOKEN"); process.exit(1); }
(async () => { try { const m = await kvGet("meta"); if (m) db = Object.assign(db, JSON.parse(m)); } catch (e) { console.error("Не удалось загрузить данные:", e.message); }
  server.listen(PORT, () => console.log("Сервер на порту " + PORT)); poll(); })();
