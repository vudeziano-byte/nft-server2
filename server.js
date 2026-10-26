// Сервер пополнения баланса статиками (XTR) для StaticGram. Node.js 18+, без зависимостей.
// Запуск: BOT_TOKEN=токен_от_BotFather_StaticGram node server.js
const http = require("http"), fs = require("fs"), crypto = require("crypto");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API = process.env.API_BASE || "https://api.staticgram.top";
const PORT = process.env.PORT || 3000;
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED === "1"; // только для теста: верить userId без проверки подписи
const DB_FILE = "db.json";

let db = { invoices: {}, charges: {}, totals: {} };      // invoices: payload -> {userId, amount, status}; totals: userId -> всего пополнено
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, "utf8"))); } catch (e) {}
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const bot = (method, body = {}) => fetch(`${API}/bot${BOT_TOKEN}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(r => r.json());

// Проверка подписи initData (алгоритм из документации StaticGram), возвращает id пользователя
function userFromInitData(initData, maxAge = 86400) {
  try {
    const p = new URLSearchParams(initData), hash = p.get("hash"); p.delete("hash");
    const check = [...p.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const exp = crypto.createHmac("sha256", secret).update(check).digest("hex");
    if (!hash || exp !== hash) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date")) > maxAge) return null;
    return String(JSON.parse(p.get("user")).id);
  } catch (e) { return null; }
}
const whoIs = b => userFromInitData(b.initData || "") || (ALLOW_UNSIGNED && b.userId ? String(b.userId) : null);

const json = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" }); res.end(JSON.stringify(obj)); };
const readBody = async req => { let raw = ""; for await (const c of req) raw += c; try { return JSON.parse(raw); } catch (e) { return {}; } };

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 200, {});
  const url = new URL(req.url, "http://x");

  if (url.pathname === "/") return json(res, 200, { ok: true });   // проверка «сервер жив» для монитора

  // Создать счёт на пополнение (ссылка для Telegram.WebApp.openInvoice)
  if (req.method === "POST" && url.pathname === "/api/invoice") {
    const b = await readBody(req), userId = whoIs(b), amount = Math.floor(Number(b.amount));
    if (!userId) return json(res, 401, { ok: false, error: "Не удалось проверить пользователя" });
    if (!(amount >= 1 && amount <= 100000)) return json(res, 400, { ok: false, error: "Сумма от 1 до 100000" });
    const payload = crypto.randomBytes(12).toString("hex");
    const r = await bot("createInvoiceLink", { title: "Пополнение баланса", description: `Пополнение баланса на ${amount} ⭐`, payload, currency: "XTR", prices: [{ label: "Пополнение", amount }] });
    if (!r.ok) return json(res, 502, { ok: false, error: r.description || "Не удалось создать счёт" });
    db.invoices[payload] = { userId, amount, status: "new" }; save();
    return json(res, 200, { ok: true, link: r.result });
  }

  // Сколько всего пополнено этим пользователем
  if (req.method === "GET" && url.pathname === "/api/balance") {
    const userId = whoIs({ initData: url.searchParams.get("initData"), userId: url.searchParams.get("userId") });
    if (!userId) return json(res, 401, { ok: false, error: "Не удалось проверить пользователя" });
    return json(res, 200, { ok: true, total: db.totals[userId] || 0 });
  }
  json(res, 404, { ok: false });
}).listen(PORT, () => console.log("Сервер на порту " + PORT));

// Обработка оплаты: pre_checkout_query и successful_payment (long polling)
async function poll(offset = 0) {
  try {
    const r = await bot("getUpdates", { offset, timeout: 25, allowed_updates: ["pre_checkout_query", "message"] });
    for (const u of r.result || []) {
      offset = u.update_id + 1;
      const q = u.pre_checkout_query;
      if (q) {                                           // отвечать нужно в течение 10 секунд
        const inv = db.invoices[q.invoice_payload];
        const ok = inv && inv.status === "new" && inv.userId === String(q.from.id) && q.currency === "XTR" && q.total_amount === inv.amount;
        await bot("answerPreCheckoutQuery", ok ? { pre_checkout_query_id: q.id, ok: true } : { pre_checkout_query_id: q.id, ok: false, error_message: "Счёт недействителен" });
      }
      const sp = u.message && u.message.successful_payment;
      if (sp) {
        const inv = db.invoices[sp.invoice_payload], charge = sp.telegram_payment_charge_id;
        if (inv && inv.status === "new" && !db.charges[charge]) {
          inv.status = "paid"; db.charges[charge] = inv.amount;
          db.totals[inv.userId] = (db.totals[inv.userId] || 0) + inv.amount; save();
          console.log(`Пополнение: пользователь ${inv.userId}, ${inv.amount} ⭐, платёж ${charge}`);
        }
      }
    }
  } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
  poll(offset);
}
if (!BOT_TOKEN) { console.error("Задайте BOT_TOKEN"); process.exit(1); }
poll();
