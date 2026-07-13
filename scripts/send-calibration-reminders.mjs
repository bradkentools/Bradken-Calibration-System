// Job diario: busca equipos que vencen en <= 30 dias y todavia no recibieron
// aviso para esa fecha de vencimiento, y les manda un correo a la persona
// responsable en su idioma (segun la planta). Se ejecuta desde GitHub Actions.
//
// Variables de entorno requeridas (se configuran como Secrets en GitHub):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   RESEND_API_KEY

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REMINDER_WINDOW_DAYS = 30;
const FROM_ADDRESS = "Bradken Calibration <onboarding@resend.dev>";

if (!SUPABASE_URL || !SERVICE_KEY || !RESEND_API_KEY) {
  console.error("Faltan variables de entorno (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY).");
  process.exit(1);
}

const SITE_NAME = {
  lima: "Lima", chilca: "Chilca", edmonton: "Edmonton", montjoli: "Mont-Joli",
  atchison: "Atchison", tacoma: "Tacoma", wodonga: "Wodonga", wundowie: "Wundowie",
  bassendean: "Bassendean", xuzhou: "Xuzhou", coimbatore: "Coimbatore", merlimau: "Merlimau"
};
const SITE_REGION = {
  lima: "SAM", chilca: "SAM", edmonton: "NAM", montjoli: "NAM", atchison: "NAM", tacoma: "NAM",
  wodonga: "Australia", wundowie: "Australia", bassendean: "Australia",
  xuzhou: "Asia", coimbatore: "Asia", merlimau: "Asia"
};

function emailLangForSite(siteId) {
  if (SITE_REGION[siteId] === "SAM") return "es";
  if (siteId === "xuzhou") return "zh";
  return "en";
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(dateStr + "T00:00:00");
  return Math.round((due - today) / 86400000);
}

async function supabaseFetch(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${options.method || "GET"} ${path} -> ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function sendEmail(to, subject, html) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Resend -> ${res.status}: ${text}`);
  }
}

const COPY = {
  en: {
    subject: (n) => `Calibration reminder — ${n} instrument(s) due within 30 days`,
    intro: "The following instrument(s) are due for calibration within the next 30 days:",
    cols: ["Tag", "Name", "Site", "Area", "Due date"],
    footer: "This is an automated reminder from the Bradken Calibration System."
  },
  es: {
    subject: (n) => `Recordatorio de calibración — ${n} instrumento(s) vencen en 30 días`,
    intro: "Los siguientes instrumentos vencen para calibración dentro de los próximos 30 días:",
    cols: ["Tag", "Nombre", "Planta", "Área", "Fecha de vencimiento"],
    footer: "Este es un recordatorio automático del Sistema de Calibración Bradken."
  },
  zh: {
    subject: (n) => `校准提醒 — ${n} 台仪器将在30天内到期`,
    intro: "以下仪器将在未来30天内到期需要校准：",
    cols: ["标签", "名称", "工厂", "区域", "到期日期"],
    footer: "这是Bradken校准系统发送的自动提醒。"
  }
};

function renderEmail(lang, items) {
  const c = COPY[lang];
  const rows = items.map((it) =>
    `<tr><td style="padding:4px 10px;border:1px solid #ddd;">${it.tag}</td>` +
    `<td style="padding:4px 10px;border:1px solid #ddd;">${it.name}</td>` +
    `<td style="padding:4px 10px;border:1px solid #ddd;">${SITE_NAME[it.site_id] || it.site_id}</td>` +
    `<td style="padding:4px 10px;border:1px solid #ddd;">${it.area || ""}</td>` +
    `<td style="padding:4px 10px;border:1px solid #ddd;">${it.next_calibration}</td></tr>`
  ).join("");
  const html =
    `<p>${c.intro}</p>` +
    `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">` +
    `<tr>${c.cols.map((h) => `<th style="padding:4px 10px;border:1px solid #ddd;background:#f2f2f2;text-align:left;">${h}</th>`).join("")}</tr>` +
    rows +
    `</table>` +
    `<p style="color:#888;font-size:12px;margin-top:16px;">${c.footer}</p>`;
  return { subject: c.subject(items.length), html };
}

async function main() {
  const equipment = await supabaseFetch(
    "/equipment?select=id,tag,name,site_id,area,next_calibration,responsible_email,last_reminder_sent_for" +
    "&next_calibration=not.is.null&responsible_email=not.is.null"
  );

  const due = equipment.filter((eq) => {
    const d = daysUntil(eq.next_calibration);
    return d >= 0 && d <= REMINDER_WINDOW_DAYS && eq.last_reminder_sent_for !== eq.next_calibration;
  });

  if (due.length === 0) {
    console.log("No hay equipos que necesiten recordatorio hoy.");
    return;
  }

  // Agrupa por (responsable, idioma) para mandar un solo correo por persona.
  const groups = new Map();
  for (const eq of due) {
    const lang = emailLangForSite(eq.site_id);
    const key = `${eq.responsible_email}|${lang}`;
    if (!groups.has(key)) groups.set(key, { email: eq.responsible_email, lang, items: [] });
    groups.get(key).items.push(eq);
  }

  let sent = 0;
  for (const { email, lang, items } of groups.values()) {
    const { subject, html } = renderEmail(lang, items);
    try {
      await sendEmail(email, subject, html);
      for (const it of items) {
        await supabaseFetch(`/equipment?id=eq.${it.id}`, {
          method: "PATCH",
          body: JSON.stringify({ last_reminder_sent_for: it.next_calibration })
        });
      }
      sent++;
      console.log(`Enviado a ${email} (${items.length} equipo(s), idioma=${lang})`);
    } catch (err) {
      console.error(`Error enviando a ${email}:`, err.message);
    }
  }
  console.log(`Listo. Correos enviados: ${sent}/${groups.size}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
