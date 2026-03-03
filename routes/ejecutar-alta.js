// ARCHIVO: routes/ejecutar-alta.js
// Agregar este archivo al proyecto simply-bot-mendoza
// y registrar la ruta en server.js: app.use('/api/ejecutar-alta', require('./routes/ejecutar-alta'))

const express = require("express");
const router = express.Router();
const puppeteer = require("puppeteer");
const AntiCaptcha = require("@antiadmin/anticaptchaofficial");

const ac = new AntiCaptcha();
ac.setAPIKey(process.env.ANTICAPTCHA_KEY);

const URL_BOT = "https://descuentos.mendoza.gov.ar";

async function resolverCaptcha(page, selector) {
  const imgEl = await page.$(selector);
  if (!imgEl) throw new Error(`Captcha no encontrado: ${selector}`);
  const b64 = await imgEl.screenshot({ encoding: "base64" });
  const texto = await ac.solveImage(b64, true);
  return texto.trim();
}

router.post("/", async (req, res) => {
  const { dni, montoCuota, usuario, password } = req.body;

  if (!dni || !montoCuota || !usuario || !password) {
    return res.status(400).json({ success: false, error: "Faltan parámetros: dni, montoCuota, usuario, password" });
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/114.0.0.0 Safari/537.36");

    // ── FASE 1: LOGIN ──────────────────────────────────────────────────────────
    await page.goto(`${URL_BOT}/login.asp`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector('input[name="usuario"]', { timeout: 15000 });
    await page.type('input[name="usuario"]', usuario, { delay: 50 });
    await page.type('input[name="password"]', password, { delay: 50 });

    const captcha1 = await resolverCaptcha(page, "img#img_captcha");
    await page.type('input[name="codigo"]', captcha1, { delay: 50 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
      page.evaluate(() => document.querySelector("form").submit()),
    ]);

    // ── FASE 2: BUSCAR EMPLEADO ────────────────────────────────────────────────
    await page.goto(`${URL_BOT}/personas/buscar.asp`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector('input[name="dni"]', { timeout: 10000 });
    await page.type('input[name="dni"]', String(dni).replace(/\D/g, ""), { delay: 50 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.evaluate(() => document.querySelector("form").submit()),
    ]);

    const contenido = await page.content();
    if (contenido.includes("No se encontraron resultados")) {
      return res.json({ success: false, noRegistra: true, error: "El DNI no registra como empleado público." });
    }

    // Clic en la fila del empleado
    const filaEmpleado = await page.$("tr.fila_persona, tr[onclick]");
    if (!filaEmpleado) throw new Error("No se encontró la fila del empleado en la tabla.");
    await filaEmpleado.click();
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 });

    // ── FASE 3: ABRIR MODAL ALTA ───────────────────────────────────────────────
    const botones = await page.$$("input[type='button'], button");
    let botonAlta = null;
    for (const btn of botones) {
      const val = await page.evaluate(el => el.value || el.textContent, btn);
      if (val && val.trim().toUpperCase() === "ALTA") { botonAlta = btn; break; }
    }
    if (!botonAlta) throw new Error("Botón 'Alta' no encontrado en el perfil del empleado.");
    await botonAlta.click();
    await new Promise(r => setTimeout(r, 2000)); // esperar que abra el modal

    // ── FASE 4: RESOLVER SEGUNDO CAPTCHA ──────────────────────────────────────
    const captcha2 = await resolverCaptcha(page, "img#img_verificacion");
    await page.waitForSelector('input[name="verificacion"]', { timeout: 10000 });
    await page.type('input[name="verificacion"]', captcha2, { delay: 50 });

    // ── FASE 5: INGRESAR MONTO Y CONFIRMAR ────────────────────────────────────
    await page.waitForSelector('input[name="importe_cuota"]', { timeout: 10000 });
    await page.click('input[name="importe_cuota"]', { clickCount: 3 });
    await page.type('input[name="importe_cuota"]', String(Math.round(montoCuota)), { delay: 50 });

    // Clic en "Control" para validar el monto
    const botonesControl = await page.$$("input[type='button'], button");
    let botonControl = null;
    for (const btn of botonesControl) {
      const val = await page.evaluate(el => el.value || el.textContent, btn);
      if (val && val.trim().toUpperCase() === "CONTROL") { botonControl = btn; break; }
    }
    if (!botonControl) throw new Error("Botón 'Control' no encontrado.");
    await botonControl.click();
    await new Promise(r => setTimeout(r, 2000));

    // Verificar que el monto fue aceptado (no excede el cupo)
    const textoTrasControl = await page.evaluate(() => document.body.innerText);
    if (textoTrasControl.includes("excede") || textoTrasControl.includes("no permitidos")) {
      return res.json({ success: false, error: "El monto solicitado excede el cupo disponible del empleado." });
    }

    // ── FASE 6: CONFIRMAR ALTA (en lugar de Cancelar) ─────────────────────────
    const botonesConfirmar = await page.$$("input[type='button'], button, input[type='submit']");
    let botonConfirmar = null;
    for (const btn of botonesConfirmar) {
      const val = await page.evaluate(el => el.value || el.textContent, btn);
      if (val && ["GENERAR", "CONFIRMAR", "ACEPTAR", "GUARDAR"].includes(val.trim().toUpperCase())) {
        botonConfirmar = btn; break;
      }
    }
    if (!botonConfirmar) throw new Error("Botón de confirmación no encontrado.");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {}),
      botonConfirmar.click(),
    ]);

    await new Promise(r => setTimeout(r, 2000));

    // ── FASE 7: CAPTURAR COMPROBANTE ──────────────────────────────────────────
    const textoPagina = await page.evaluate(() => document.body.innerText);
    const htmlPagina  = await page.content();

    // Buscar número de código/comprobante generado por el gobierno
    const matchCodigo = textoPagina.match(/[Cc][Óó]digo[:\s#]*([A-Z0-9\-]+)/);
    const matchNro    = textoPagina.match(/[Nn][úu]mero[:\s#]*([A-Z0-9\-]+)/);
    const codigoCAD   = matchCodigo?.[1] || matchNro?.[1] || null;

    // Screenshot de la confirmación como respaldo
    const screenshotB64 = await page.screenshot({ encoding: "base64", fullPage: true });

    return res.json({
      success:       true,
      codigoCAD,
      dni,
      montoCuota:    Math.round(montoCuota),
      textoPagina:   textoPagina.slice(0, 500), // primeros 500 chars para debug
      screenshotB64, // el frontend puede guardarlo en Storage
    });

  } catch (error) {
    console.error("[ejecutar-alta] Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

module.exports = router;
