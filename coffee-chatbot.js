/**
 * coffee-chatbot.js  (single-file server + widget)
 *
 * Features:
 * - Multi-language (EN/EL/FR/ES) auto-detect by model instruction
 * - Voice: browser SpeechRecognition + SpeechSynthesis
 * - Online ordering via tool: create_order (mock). Replace with Square/Toast/etc.
 * - Provider adapters: OpenAI implemented; Claude/Gemini/Grok stubs with TODO
 *
 * Run:
 *   1) Node 18+ (needed for global fetch)
 *   2) Set env:
 *        PROVIDER=openai
 *        API_KEY=your_key
 *        MODEL=gpt-4o-mini   (or any chat-capable model you have)
 *      then:
 *        node coffee-chatbot.js
 *
 * Open:
 *   http://localhost:3000
 */

const http = require("http");
const { randomUUID } = require("crypto");
const url = require("url");

// ------------------------- CONFIG -------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PROVIDER = (process.env.PROVIDER || "openai").toLowerCase();
const API_KEY = process.env.API_KEY || "";
const MODEL = process.env.MODEL || "gpt-4o-mini";

// Basic shop data (edit freely)
const SHOP = {
  name: "Your Coffee Shop",
  currency: "EUR",
  languages: ["English", "Greek", "French", "Spanish"],
  hours: "Mon-Sun 07:00–20:00",
  address: "123 Coffee Street",
  phone: "+30 000 000 0000",
  orderingPolicy:
    "Takeaway only by default. Confirm allergies. Do not promise delivery unless tool says delivery is available.",
  menu: [
    { id: "cap", name: "Cappuccino", price: 3.8, tags: ["coffee"], options: ["single", "double"], milks: ["whole", "skim", "oat", "almond"] },
    { id: "lat", name: "Latte", price: 4.0, tags: ["coffee"], options: ["single", "double"], milks: ["whole", "skim", "oat", "almond"] },
    { id: "esp", name: "Espresso", price: 2.4, tags: ["coffee"], options: ["single", "double"] },
    { id: "fre", name: "Freddo Espresso", price: 3.5, tags: ["coffee", "cold"] },
    { id: "tea", name: "Tea", price: 2.8, tags: ["tea"], options: ["black", "green", "herbal"] },
    { id: "cro", name: "Croissant", price: 2.6, tags: ["pastry"], allergens: ["gluten", "dairy", "egg"] },
  ],
};

// In-memory "orders DB" (replace with real DB + integrations)
const ORDERS = new Map(); // orderId -> { ... }
const CONVERSATIONS = new Map(); // sessionId -> messages[]

// ------------------------- UTIL -------------------------
function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": typeof body === "string" ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers,
  });
  res.end(payload);
}

function notFound(res) {
  send(res, 404, { error: "Not found" });
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// ------------------------- TOOLS (external services) -------------------------
/**
 * Tool protocol:
 * The model must respond with JSON in ONE of these forms:
 *   { "tool_call": { "name": "...", "arguments": { ... } } }
 *   { "final": "..." }
 */
const TOOLS = [
  {
    name: "get_menu",
    description: "Get menu items and prices (optionally filtered by category/tag).",
    schema: {
      type: "object",
      properties: { tag: { type: "string", description: "e.g. coffee, tea, pastry, cold" } },
      required: [],
    },
  },
  {
    name: "create_order",
    description: "Create an online order for pickup. Use to place an order.",
    schema: {
      type: "object",
      properties: {
        customerName: { type: "string" },
        phone: { type: "string" },
        language: { type: "string", description: "en | el | fr | es" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              menuItemId: { type: "string" },
              qty: { type: "integer", minimum: 1, maximum: 20 },
              size: { type: "string", description: "optional (e.g. small/medium/large)" },
              milk: { type: "string", description: "optional (e.g. oat)" },
              notes: { type: "string", description: "optional notes (e.g. decaf)" },
            },
            required: ["menuItemId", "qty"],
          },
        },
        pickupTime: { type: "string", description: "ISO time or natural text like 'in 20 minutes'" },
        specialInstructions: { type: "string" },
      },
      required: ["customerName", "phone", "items"],
    },
  },
  {
    name: "get_order_status",
    description: "Check order status by orderId.",
    schema: {
      type: "object",
      properties: { orderId: { type: "string" } },
      required: ["orderId"],
    },
  },
];

// Replace these with real integrations (Square/Toast/Shopify/etc.)
async function executeTool(name, args) {
  if (name === "get_menu") {
    const tag = (args?.tag || "").toLowerCase().trim();
    const items = tag ? SHOP.menu.filter((m) => (m.tags || []).includes(tag)) : SHOP.menu;
    return { shop: SHOP.name, currency: SHOP.currency, items };
  }

  if (name === "create_order") {
    // Validate basic items
    const items = Array.isArray(args?.items) ? args.items : [];
    if (!items.length) return { ok: false, error: "No items provided." };

    // Price calculation
    const lineItems = [];
    let total = 0;
    for (const it of items) {
      const menuItem = SHOP.menu.find((m) => m.id === it.menuItemId);
      if (!menuItem) return { ok: false, error: `Unknown menu item: ${it.menuItemId}` };

      const qty = Math.max(1, Math.min(20, Number(it.qty || 1)));
      const lineTotal = menuItem.price * qty;
      total += lineTotal;

      lineItems.push({
        id: menuItem.id,
        name: menuItem.name,
        qty,
        unitPrice: menuItem.price,
        lineTotal,
        milk: it.milk || null,
        size: it.size || null,
        notes: it.notes || null,
      });
    }

    const orderId = "ORD-" + randomUUID().slice(0, 8).toUpperCase();
    const order = {
      orderId,
      status: "RECEIVED", // Later: RECEIVED -> IN_PROGRESS -> READY -> COMPLETED
      createdAt: new Date().toISOString(),
      customerName: args.customerName,
      phone: args.phone,
      pickupTime: args.pickupTime || "ASAP",
      specialInstructions: args.specialInstructions || "",
      currency: SHOP.currency,
      total: Math.round(total * 100) / 100,
      items: lineItems,
    };
    ORDERS.set(orderId, order);

    // TODO: Replace with real order creation:
    // - Square Orders API / Toast API / Shopify draft order / custom POS
    // - Payment link via Stripe
    // - SMS confirmation via Twilio

    return { ok: true, order };
  }

  if (name === "get_order_status") {
    const order = ORDERS.get(args?.orderId);
    if (!order) return { ok: false, error: "Order not found." };
    return { ok: true, orderId: order.orderId, status: order.status, pickupTime: order.pickupTime };
  }

  return { ok: false, error: `Tool not implemented: ${name}` };
}

// ------------------------- PROMPT -------------------------
function buildSystemPrompt() {
  // Force JSON protocol + multilingual behavior
  return `
You are the AI assistant for a coffee shop website: "${SHOP.name}".

You must:
- Help customers with menu questions, allergens, shop info, and online ordering.
- Support languages: English, Greek, French, Spanish.
- Reply in the SAME language as the user. If unclear, ask which language they prefer.
- Be concise, friendly, and confirm important order details (items, milk, size, pickup time, phone).
- Ask about allergies when relevant (milk, gluten, nuts).

VERY IMPORTANT OUTPUT FORMAT:
You MUST reply with VALID JSON only (no markdown, no extra text).
Choose ONE of:
1) {"tool_call":{"name":"TOOL_NAME","arguments":{...}}}
2) {"final":"your reply to the user"}

Available tools (name + what they do):
${TOOLS.map(t => `- ${t.name}: ${t.description} Args schema: ${JSON.stringify(t.schema)}`).join("\n")}

Shop info:
- Hours: ${SHOP.hours}
- Address: ${SHOP.address}
- Phone: ${SHOP.phone}
- Ordering policy: ${SHOP.orderingPolicy}

When the user wants to order, you SHOULD call "create_order" after gathering missing details.
If user asks menu/prices, call "get_menu".
If user asks about an existing order, call "get_order_status".

If you do not need a tool, respond with {"final":"..."}.
`.trim();
}

// ------------------------- LLM PROVIDERS -------------------------
async function callLLM({ messages, temperature = 0.3 }) {
  if (!API_KEY) {
    return { text: `{"final":"Server missing API_KEY. Set API_KEY environment variable."}` };
  }

  if (PROVIDER === "openai") return callOpenAI({ messages, temperature });

  // Stubs (so everything is still “one file”)
  if (PROVIDER === "anthropic") return callAnthropicStub({ messages });
  if (PROVIDER === "gemini") return callGeminiStub({ messages });
  if (PROVIDER === "xai" || PROVIDER === "grok") return callXaiStub({ messages });

  return { text: `{"final":"Unknown PROVIDER. Use openai | anthropic | gemini | xai."}` };
}

async function callOpenAI({ messages, temperature }) {
  // Using OpenAI Chat Completions (works broadly). You can swap to Responses API if you prefer.
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return { text: `{"final":"OpenAI error: ${resp.status}. ${escapeForJson(errText).slice(0, 400)}"}` };
  }
  const data = await resp.json();
  const text = data?.choices?.[0]?.message?.content ?? `{"final":"No response text."}`;
  return { text };
}

// NOTE: These are stubs to keep it one-file.
// Replace the TODO blocks with the correct REST call for your provider.
async function callAnthropicStub({ messages }) {
  return {
    text: `{"final":"PROVIDER=anthropic is stubbed in this one-file demo. Switch to PROVIDER=openai, or edit callAnthropicStub() to call Anthropic's API."}`
  };
}
async function callGeminiStub({ messages }) {
  return {
    text: `{"final":"PROVIDER=gemini is stubbed in this one-file demo. Switch to PROVIDER=openai, or edit callGeminiStub() to call Gemini API."}`
  };
}
async function callXaiStub({ messages }) {
  return {
    text: `{"final":"PROVIDER=xai (Grok) is stubbed in this one-file demo. Switch to PROVIDER=openai, or edit callXaiStub() to call xAI API."}`
  };
}

function escapeForJson(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// ------------------------- ORCHESTRATOR -------------------------
async function runAssistant(sessionId, userText) {
  const systemPrompt = buildSystemPrompt();
  const history = CONVERSATIONS.get(sessionId) || [];

  // Keep history short
  const trimmedHistory = history.slice(-20);

  const messages = [
    { role: "system", content: systemPrompt },
    ...trimmedHistory,
    { role: "user", content: userText },
  ];

  // tool loop
  for (let step = 0; step < 6; step++) {
    const llm = await callLLM({ messages });
    const raw = (llm.text || "").trim();

    const obj = safeJsonParse(raw);
    if (!obj) {
      // If model fails JSON, nudge it once
      messages.push({ role: "assistant", content: raw });
      messages.push({
        role: "user",
        content: `Reminder: reply with VALID JSON only. Use {"final":"..."} or {"tool_call":{...}}.`,
      });
      continue;
    }

    if (obj.tool_call?.name) {
      const toolName = obj.tool_call.name;
      const toolArgs = obj.tool_call.arguments || {};
      const result = await executeTool(toolName, toolArgs);

      messages.push({ role: "assistant", content: raw }); // record the tool call JSON
      messages.push({ role: "tool", content: JSON.stringify({ tool: toolName, result }) });

      // If tool failed, let model explain next
      if (result?.ok === false) {
        messages.push({
          role: "user",
          content: `Tool result indicates failure. Explain to the customer and ask for what you need.`,
        });
      }
      continue;
    }

    if (typeof obj.final === "string") {
      const assistantText = obj.final;

      // Save back history (excluding system)
      const newHistory = [
        ...trimmedHistory,
        { role: "user", content: userText },
        { role: "assistant", content: assistantText },
      ].slice(-20);

      CONVERSATIONS.set(sessionId, newHistory);
      return { reply: assistantText };
    }

    // Unknown JSON shape
    messages.push({ role: "user", content: `Your JSON must include either "final" or "tool_call". Try again.` });
  }

  return { reply: "Sorry—something went wrong. Please try again." };
}

// ------------------------- SERVER ROUTES -------------------------
const WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${SHOP.name} - AI Chatbot</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;margin:0;background:#fafafa;color:#111}
    .wrap{max-width:980px;margin:0 auto;padding:20px}
    .top{display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:space-between}
    .badge{font-size:12px;padding:6px 10px;border:1px solid #ddd;border-radius:999px;background:#fff}
    .card{background:#fff;border:1px solid #eaeaea;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.04)}
    .chat{display:flex;flex-direction:column;height:70vh;min-height:520px}
    .msgs{flex:1;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:10px}
    .msg{max-width:78%;padding:10px 12px;border-radius:14px;border:1px solid #eee;white-space:pre-wrap}
    .me{align-self:flex-end;background:#111;color:#fff;border-color:#111}
    .bot{align-self:flex-start;background:#fff}
    .row{display:flex;gap:8px;padding:12px;border-top:1px solid #eee}
    input{flex:1;padding:12px;border-radius:12px;border:1px solid #ddd;font-size:16px}
    button{padding:12px 14px;border-radius:12px;border:1px solid #111;background:#111;color:#fff;font-weight:600;cursor:pointer}
    button.secondary{background:#fff;color:#111;border-color:#ddd}
    button:disabled{opacity:.5;cursor:not-allowed}
    .hint{font-size:13px;color:#555;margin-top:10px}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="top">
      <h2 style="margin:0">${SHOP.name} — AI Chat</h2>
      <div class="badge">Languages: EN • EL • FR • ES</div>
      <div class="badge">Voice: ✅ (browser)</div>
      <div class="badge">Online ordering: ✅ (mock tool)</div>
    </div>

    <div class="card chat" style="margin-top:14px">
      <div class="msgs" id="msgs"></div>
      <div class="row">
        <button class="secondary" id="micBtn" title="Voice input">🎙️</button>
        <input id="input" placeholder="Ask about menu, hours, or place an order…" />
        <button id="sendBtn">Send</button>
      </div>
    </div>

    <div class="hint">
      Try: “What’s on the menu?”, “I want 2 cappuccinos with oat milk”, “Θέλω έναν freddo espresso”, “Je veux commander un latte”.
    </div>
  </div>

<script>
  const sessionId = localStorage.getItem("coffee_session") || (crypto.randomUUID());
  localStorage.setItem("coffee_session", sessionId);

  const msgsEl = document.getElementById("msgs");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("sendBtn");
  const micBtn = document.getElementById("micBtn");

  function addMsg(text, who){
    const div = document.createElement("div");
    div.className = "msg " + (who==="me" ? "me" : "bot");
    div.textContent = text;
    msgsEl.appendChild(div);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  async function send(text){
    if(!text.trim()) return;
    addMsg(text, "me");
    inputEl.value = "";
    sendBtn.disabled = true;

    try{
      const r = await fetch("/api/chat", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ sessionId, message: text })
      });
      const data = await r.json();
      addMsg(data.reply || "(no reply)", "bot");
      // Speak back (optional)
      speak(data.reply || "");
    }catch(e){
      addMsg("Server error. Check console.", "bot");
      console.error(e);
    }finally{
      sendBtn.disabled = false;
      inputEl.focus();
    }
  }

  sendBtn.addEventListener("click", ()=> send(inputEl.value));
  inputEl.addEventListener("keydown", (e)=>{ if(e.key==="Enter") send(inputEl.value); });

  // ---- Voice: SpeechRecognition (STT) + SpeechSynthesis (TTS)
  function speak(text){
    if(!text) return;
    try{
      const u = new SpeechSynthesisUtterance(text);
      // Let the browser pick a matching voice automatically
      window.speechSynthesis.speak(u);
    }catch{}
  }

  let stopRec = null;

  micBtn.addEventListener("click", ()=>{
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if(!SR){
      alert("SpeechRecognition not supported in this browser. Try Chrome/Edge.");
      return;
    }
    if(stopRec){
      stopRec(); stopRec = null;
      micBtn.textContent = "🎙️";
      return;
    }
    const rec = new SR();
    rec.lang = "en-US"; // user can speak other langs too; browser often still works
    rec.interimResults = false;

    rec.onresult = (e)=>{
      const t = e.results[0][0].transcript;
      send(t);
    };
    rec.onerror = ()=>{ stopRec=null; micBtn.textContent="🎙️"; };
    rec.onend = ()=>{ stopRec=null; micBtn.textContent="🎙️"; };

    rec.start();
    stopRec = ()=>{ try{ rec.stop(); }catch{} };
    micBtn.textContent = "⏹️";
  });

  // Greeting
  addMsg("Hi! Ask me about the menu, hours, or place an online pickup order. (EN/EL/FR/ES)", "bot");
</script>
</body>
</html>`;

// ------------------------- HTTP SERVER -------------------------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  if (req.method === "GET" && parsed.pathname === "/") {
    return send(res, 200, WIDGET_HTML, { "Content-Type": "text/html; charset=utf-8" });
  }

  if (req.method === "POST" && parsed.pathname === "/api/chat") {
    try {
      const body = await readJson(req);
      const sessionId = body.sessionId || "default";
      const message = String(body.message || "");

      const out = await runAssistant(sessionId, message);
      return send(res, 200, out);
    } catch (e) {
      return send(res, 500, { error: "Server error", details: String(e?.message || e) });
    }
  }

  if (req.method === "GET" && parsed.pathname === "/api/health") {
    return send(res, 200, {
      ok: true,
      provider: PROVIDER,
      model: MODEL,
      shop: SHOP.name,
      ordersInMemory: ORDERS.size,
    });
  }

  return notFound(res);
});

server.listen(PORT, () => {
  console.log(`✅ Coffee chatbot running on http://localhost:${PORT}`);
  console.log(`Provider=${PROVIDER} Model=${MODEL}`);
  if (!API_KEY) console.log("⚠️  Missing API_KEY env var. The bot will respond with an error until set.");
});
