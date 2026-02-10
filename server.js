import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ENV
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// (Opcional) Google Sheets
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL; 
// Esto será una URL de Apps Script que guarda leads en una sheet

// Sesiones en memoria (MVP). En producción: Redis/DB.
const sessions = new Map();
function getSession(user) {
  if (!sessions.has(user)) sessions.set(user, { step: "START", data: {} });
  return sessions.get(user);
}

async function sendText(to, text) {
  const url = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body: text },
    }),
  });
}

async function saveLead(lead) {
  if (!SHEETS_WEBHOOK_URL) return;
  try {
    await fetch(SHEETS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(lead),
    });
  } catch (e) {
    // No rompemos el flujo si Sheets falla
    console.error("Sheets error:", e?.message || e);
  }
}

// 1) Verificación del webhook (Meta)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// 2) Recepción de mensajes
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const msg = change?.value?.messages?.[0];
    if (!msg) return res.sendStatus(200);

    const from = msg.from;
    const textRaw = (msg.text?.body || "").trim();
    const text = textRaw.toLowerCase();

    const s = getSession(from);

    const urgentRegex = /(urgencia|urgente|falleci|falleció|murio|murió|ahora|24|emerg)/i;
    if (urgentRegex.test(text)) {
      s.step = "URGENT";
      await sendText(
        from,
        "🚨 Para atención inmediata 24 hs: 351 531 1114.\nSi querés, decime tu nombre y zona y te acompañamos."
      );
      return res.sendStatus(200);
    }

    // START → MENU
    if (s.step === "START") {
      s.step = "MENU";
      await sendText(
        from,
        "👋 Hola, soy el asistente de Los Capuchinos BIO.\nElegí una opción:\n1️⃣ Afiliaciones (Planes)\n2️⃣ Urgencias 24 hs\n3️⃣ Hablar con un asesor"
      );
      return res.sendStatus(200);
    }

    // MENU
    if (s.step === "MENU") {
      if (text.startsWith("2")) {
        s.step = "URGENT";
        await sendText(from, "🚨 Para atención inmediata 24 hs: 351 531 1114.\nSi querés, decime tu nombre y zona.");
      } else if (text.startsWith("3")) {
        s.step = "HUMAN";
        await sendText(from, "Perfecto. Un asesor te contactará a la brevedad.\n📱 Afiliaciones: 351 531 1115\n🚨 Urgencias 24 hs: 351 531 1114");
      } else {
        s.step = "TYPE";
        await sendText(from, "Perfecto 😊 ¿La cobertura es para:\n1️⃣ Vos\n2️⃣ Tu familia\n3️⃣ Persona mayor?");
      }
      return res.sendStatus(200);
    }

    // TYPE
    if (s.step === "TYPE") {
      if (text.startsWith("1")) {
        s.data.tipo = "Individual";
        s.step = "PRIORITY";
        await sendText(from, "¿Qué valorás más?\n1) Tranquilidad de costos\n2) Acompañamiento\n3) Enfoque ecológico");
      } else if (text.startsWith("2")) {
        s.data.tipo = "Familiar";
        s.step = "FAMILY";
        await sendText(from, "Genial 💚 ¿Cuántas personas serían y en qué zona estás?");
      } else {
        s.data.tipo = "Mayor";
        s.step = "MAYOR75";
        await sendText(from, "Gracias. ¿La persona es mayor de 75? (Sí/No)");
      }
      return res.sendStatus(200);
    }

    // PRIORITY → DATA
    if (s.step === "PRIORITY") {
      s.data.prioridad =
        text.startsWith("1") ? "Costos" : text.startsWith("2") ? "Acompañamiento" : "Enfoque ecológico";
      s.data.plan = "Plan Individual BIO";
      s.step = "DATA";
      await sendText(from, "Por lo que me contás, te conviene el Plan Individual BIO.\nPara avanzar: Nombre completo, DNI y fecha de nacimiento (en un solo mensaje).");
      return res.sendStatus(200);
    }

    // FAMILY → DATA
    if (s.step === "FAMILY") {
      s.data.detalle_familia = textRaw;
      s.data.plan = "Plan Familiar BIO";
      s.step = "DATA";
      await sendText(from, "Por lo que me contás, te conviene el Plan Familiar BIO.\nPara avanzar: Nombre completo, DNI y fecha de nacimiento (en un solo mensaje).");
      return res.sendStatus(200);
    }

    // MAYOR75 → DATA
    if (s.step === "MAYOR75") {
      s.data.mayor75 = /si|sí/.test(text);
      s.data.plan = "Plan Mayor BIO";
      s.step = "DATA";
      await sendText(from, "Por lo que me contás, te conviene el Plan Mayor BIO.\nPara avanzar: Nombre completo, DNI y fecha de nacimiento (en un solo mensaje).");
      return res.sendStatus(200);
    }

    // DATA → DONE (guardar lead)
    if (s.step === "DATA") {
      s.data.datos = textRaw;
      s.step = "DONE";

      await saveLead({
        telefono: from,
        tipo: s.data.tipo || "",
        plan: s.data.plan || "",
        prioridad: s.data.prioridad || "",
        mayor75: s.data.mayor75 ?? "",
        detalle_familia: s.data.detalle_familia || "",
        datos: s.data.datos || "",
        timestamp: new Date().toISOString(),
      });

      await sendText(from, "¡Gracias! 🙌 Un asesor se va a comunicar a la brevedad.\n📱 Afiliaciones: 351 531 1115\n🚨 Urgencias 24 hs: 351 531 1114");
      return res.sendStatus(200);
    }

    // fallback
    s.step = "MENU";
    await sendText(from, "¿Qué necesitás?\n1️⃣ Afiliaciones (Planes)\n2️⃣ Urgencias 24 hs\n3️⃣ Hablar con un asesor");
    return res.sendStatus(200);

  } catch (e) {
    console.error(e);
    return res.sendStatus(200);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Bot listo"));
