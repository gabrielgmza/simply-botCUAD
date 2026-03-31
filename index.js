require('dotenv').config();
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const axios = require('axios');
const ac = require('@antiadmin/anticaptchaofficial');

const app = express();
app.use(cors());
app.use(express.json());

ac.setAPIKey(process.env.ANTICAPTCHA_KEY || '');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function calcularCuil(dni, sexo) {
    const dniStr = dni.padStart(8, '0');
    let prefijo = sexo === 'M' ? '20' : '27';
    const mult = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let base = prefijo + dniStr;
    let suma = 0;
    for (let i = 0; i < 10; i++) suma += parseInt(base[i]) * mult[i];
    let digito = 11 - (suma % 11);
    if (digito === 11) digito = 0;
    if (digito === 10) { prefijo = '23'; digito = sexo === 'M' ? 9 : 4; base = prefijo + dniStr; }
    return base + digito.toString();
}

async function launchBrowser() {
    return puppeteer.launch({
        headless: 'new',
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1920,1080'],
        defaultViewport: null,
    });
}

async function configurarPagina(page) {
    const cdp = await page.target().createCDPSession();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false,
        screenWidth: 1920, screenHeight: 1080,
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
        try {
            Object.defineProperty(screen, 'width',      { get: () => 1920, configurable: true });
            Object.defineProperty(screen, 'height',     { get: () => 1080, configurable: true });
            Object.defineProperty(screen, 'availWidth', { get: () => 1920, configurable: true });
            Object.defineProperty(screen, 'availHeight',{ get: () => 1040, configurable: true });
        } catch(e) {}
    });
    page.setDefaultNavigationTimeout(90000);
    page.setDefaultTimeout(30000);
}

async function resolverCaptcha(bmpBuffer, browser) {
    if (!bmpBuffer || bmpBuffer.length < 100) return null;
    const convPage = await browser.newPage();
    try {
        const bmpBase64 = bmpBuffer.toString('base64');
        const pngBase64 = await convPage.evaluate(async (b64) => {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.width; c.height = img.height;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c.toDataURL('image/png').split(',')[1]);
                };
                img.onerror = () => reject(new Error('BMP load failed'));
                img.src = 'data:image/bmp;base64,' + b64;
            });
        }, bmpBase64);
        await convPage.close();

        if (process.env.ANTICAPTCHA_KEY) {
            try {
                const sol = await ac.solveImage(pngBase64, true);
                console.log(`[CAPTCHA] ✅ "${sol}"`);
                if (sol && sol.length >= 2) return sol;
            } catch(e) { console.log(`[CAPTCHA] Anti-Captcha error: ${e.message}`); }
        }

        try {
            const Tesseract = require('tesseract.js');
            const { data: { text } } = await Tesseract.recognize(Buffer.from(pngBase64, 'base64'), 'eng',
                { tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' });
            const limpio = text.replace(/[^a-zA-Z0-9]/g, '').trim();
            if (limpio.length >= 3) return limpio;
        } catch(e) {}
    } catch(e) { await convPage.close().catch(() => {}); console.log(`[CAPTCHA] Error: ${e.message}`); }
    return null;
}

async function intentarLogin(page, browser, usuario, password) {
    let captchaBmp = null;
    const captchaHandler = async (resp) => {
        if (resp.url().includes('aspcaptcha.asp')) {
            try { captchaBmp = await resp.buffer(); } catch(e) {}
        }
    };
    page.on('response', captchaHandler);

    await page.goto('https://descuentos.mendoza.gov.ar/', { waitUntil: 'networkidle2' });
    await sleep(3000);
    if (page.url().includes('logout_resolucion')) throw new Error('Screen check falló');
    if (!page.url().includes('login.asp')) {
        await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
        if (!page.url().includes('login.asp'))
            await page.goto('https://descuentos.mendoza.gov.ar/login.asp', { waitUntil: 'networkidle2' });
    }

    let loginFrame = null;
    for (let i = 0; i < 20 && !loginFrame; i++) { await sleep(1500); loginFrame = page.frames().find(f => f.url().includes('Modo=M')); }
    if (!loginFrame) throw new Error('Modo=M no apareció');

    for (let i = 0; i < 10 && !captchaBmp; i++) await sleep(500);
    page.off('response', captchaHandler);

    const captchaSol = await resolverCaptcha(captchaBmp, browser);
    if (!captchaSol) throw new Error('Captcha no resuelto');
    console.log(`  captcha="${captchaSol}"`);

    await loginFrame.waitForSelector('#user', { timeout: 10000 });
    await loginFrame.click('#user', { clickCount: 3 }); await loginFrame.type('#user', usuario, { delay: 60 });
    await loginFrame.click('#password', { clickCount: 3 }); await loginFrame.type('#password', password, { delay: 60 });
    if (await loginFrame.$('#txtCaptcha')) { await loginFrame.click('#txtCaptcha', { clickCount: 3 }); await loginFrame.type('#txtCaptcha', captchaSol, { delay: 30 }); }
    const mac = await loginFrame.$eval('#hCadMac', el => el.value).catch(() => '');
    if (!mac || mac === '0') await loginFrame.$eval('#hCadMac', (el, v) => el.value = v, String(usuario.length + password.length + 6));

    await page.setRequestInterception(true);
    let loginOk = false, interceptActive = true;
    const reqHandler = (req) => {
        if (!interceptActive) { req.continue().catch(() => {}); return; }
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() &&
            (req.url() === 'https://descuentos.mendoza.gov.ar/' || req.url().endsWith('/default.asp'))) {
            loginOk = true;
            req.continue({ url: 'https://descuentos.mendoza.gov.ar/principal.asp' }).catch(() => {});
            return;
        }
        req.continue().catch(() => {});
    };
    page.on('request', reqHandler);

    await loginFrame.evaluate(() => { if (typeof Aceptar === 'function') Aceptar(); else document.getElementById('form1')?.submit(); });
    for (let i = 0; i < 30 && !loginOk; i++) await sleep(1000);
    interceptActive = false;
    page.off('request', reqHandler);
    await page.setRequestInterception(false).catch(() => {});

    if (!loginOk) throw new Error('Login no disparó "/"');

    await sleep(5000);
    const html = await page.content().catch(() => '');
    return html.includes('Tab_Registra');
}

// ── Tab Personas + input DNI ──────────────────────────────────
async function irAPersonas(page) {
    console.log(`[PERSONAS] frames antes Tab_Click: ${page.frames().map(f => f.name()+'='+f.url().split('/').pop()).join(', ')}`);
    await page.evaluate(() => { try { Tab_Click('Personas'); } catch(e) {} });
    await sleep(8000);
    console.log(`[PERSONAS] frames post Tab_Click: ${page.frames().map(f => f.name()+'='+f.url().split('/').pop()).join(', ')}`);
    const selectors = ['input[name="Per_NroDoc"]', 'input[name="dni"]', 'input[name="Documento"]'];
    let dniFrame = null, dniSelector = null;
    const iPersonas = page.frames().find(f => f.name() === 'iPersonas');
    console.log(`[PERSONAS] iPersonas: ${iPersonas ? iPersonas.url() : 'NO'}`);
    if (iPersonas) {
        const ipHtml = await iPersonas.content().catch(() => '');
        console.log(`[PERSONAS] iPersonas html (500c): ${ipHtml.substring(0, 500)}`);
        for (const sel of selectors) {
            if (await iPersonas.$(sel).catch(() => null)) { dniFrame = iPersonas; dniSelector = sel; break; }
        }
    }
    if (!dniFrame) {
        for (let i = 0; i < 3 && !dniFrame; i++) {
            console.log(`[PERSONAS] intento ${i+1} buscando input DNI...`);
            for (const f of page.frames()) {
                for (const sel of selectors) {
                    if (await f.$(sel).catch(() => null)) { dniFrame = f; dniSelector = sel; break; }
                }
                if (dniFrame) break;
            }
            if (!dniFrame) await sleep(3000);
        }
    }
    console.log(`[PERSONAS] resultado: dniFrame=${dniFrame ? dniFrame.name() : 'NO'} selector=${dniSelector}`);
    return { dniFrame, dniSelector };
}

// ── Buscar DNI y retornar grilla ──────────────────────────────
async function buscarDNI(page, dniFrame, dniSelector, dniLimpio) {
    await dniFrame.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); } }, dniSelector);
    await dniFrame.type(dniSelector, dniLimpio, { delay: 50 });
    await dniFrame.evaluate(() => {
        try {
            if (typeof Buscar === 'function') { Buscar(); return; }
            if (typeof Aceptar === 'function') { Aceptar(); return; }
            const form = document.getElementById('form1') || document.forms[0];
            if (form) { const modo = document.getElementById('Modo'); if (modo) modo.value = 'Buscar'; form.submit(); }
        } catch(e) {}
    });
    await sleep(8000);
    let grillaHtml = '';
    const grillaFrame = page.frames().find(f => f.name() === 'ifrGrillaPersonas');
    if (grillaFrame) grillaHtml = await grillaFrame.content().catch(() => '');
    if (!grillaHtml) grillaHtml = await page.evaluate(() => document.body?.innerHTML || '').catch(() => '');
    return { grillaHtml, grillaFrame };
}

// ── Parsear grilla — detecta si Socio=SI/NO ───────────────────
// Retorna array de { index, nombre, esSocio, sexoCelda }
function parsearGrilla(html) {
    const filas = [];
    const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let match, idx = 0;
    while ((match = rowRegex.exec(html)) !== null) {
        const row = match[0];
        if (row.toLowerCase().includes('<th')) continue;
        const cells = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [])
            .map(c => c.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim());
        if (cells.length < 2) continue;
        const nombre = cells.find(c => c.length > 3 && /[a-zA-ZáéíóúÁÉÍÓÚñÑ]/.test(c)) || '';
        const sexoCelda = cells.find(c => c === 'M' || c === 'F') || '';
        // Columna Socio: "SI" o "NO" — suele ser la última o penúltima
        const esSocio = cells.some(c => c.trim().toUpperCase() === 'SI');
        if (nombre) { filas.push({ index: idx, nombre, sexoCelda, esSocio, cells }); idx++; }
    }
    return filas;
}

// ── Abrir Propiedades del legajo (click derecho → Propiedades) ─
async function abrirPropiedades(page, grillaFrame, rowIndex) {
    const frame = grillaFrame || page;
    // Hacer click derecho en la fila para abrir menu contextual
    await frame.evaluate((idx) => {
        const rows = Array.from(document.querySelectorAll('tr')).filter(r =>
            !r.querySelector('th') && r.querySelectorAll('td').length >= 2);
        if (!rows[idx]) return;
        rows[idx].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    }, rowIndex);
    await sleep(2000);

    // Buscar y clickear "Propiedades" en el menú contextual (en cualquier frame)
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            // Menú contextual puede ser un <div> o <ul> con opciones
            const items = Array.from(document.querySelectorAll('a, li, div, span, td'));
            const prop = items.find(el => /propiedades/i.test(el.innerText || el.textContent || ''));
            if (prop) { prop.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) break;
    }

    // Alternativa: buscar botón "Propiedades" directo en la página (algunos portales lo muestran así)
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
            const btn = btns.find(b => /propiedades/i.test(b.value || b.innerText || ''));
            if (btn) { btn.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) break;
    }

    await sleep(3000);
}

// ── Afiliar persona: pestaña Afiliado → Alta Afiliado → Adherente B / ACT ──
// Retorna true si afiliación exitosa
async function afiliarPersona(page) {
    // Hacer click en pestaña "Afiliado"
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('a, span, div, td, li'));
            const tab = tabs.find(el => /^afiliado$/i.test((el.innerText || el.textContent || '').trim()));
            if (tab) { tab.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) { await sleep(2000); break; }
    }

    // Click en "Alta Afiliado"
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button, a'));
            const btn = btns.find(b => /alta\s*afiliado/i.test(b.value || b.innerText || b.textContent || ''));
            if (btn) { btn.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) { await sleep(3000); break; }
    }

    // Seleccionar categoría: preferir "Adherente B", si no existe usar primera opción disponible
    for (const f of page.frames()) {
        const seleccionado = await f.evaluate(() => {
            // Buscar select de categoría
            const selects = Array.from(document.querySelectorAll('select'));
            for (const sel of selects) {
                const opts = Array.from(sel.options);
                // Preferir Adherente B
                const adherenteB = opts.find(o => /adherente\s*b/i.test(o.text));
                // Si no, buscar ACT/Activo
                const act = opts.find(o => /^act$/i.test(o.text.trim()) || /activo/i.test(o.text));
                // Si no, tomar la última opción (generalmente la menos costosa)
                const elegida = adherenteB || act || opts[opts.length - 1];
                if (elegida) { sel.value = elegida.value; sel.dispatchEvent(new Event('change', { bubbles: true })); return elegida.text; }
            }
            // Alternativa: radio buttons con texto
            const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
            if (radios.length > 0) {
                const last = radios[radios.length - 1];
                last.checked = true; last.dispatchEvent(new Event('change', { bubbles: true }));
                const label = document.querySelector(`label[for="${last.id}"]`);
                return label?.innerText || 'ultima opcion';
            }
            return null;
        }).catch(() => null);
        if (seleccionado) { console.log(`[AFILIACION] Categoría elegida: ${seleccionado}`); await sleep(1000); break; }
    }

    // Click Aceptar en el modal de Alta
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button, input[type="submit"]'));
            const btn = btns.find(b => /^aceptar$/i.test((b.value || b.innerText || '').trim()));
            if (btn) { btn.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) { await sleep(3000); break; }
    }

    // Modal "¿Desea imprimir comprobante?" → click NO
    for (let i = 0; i < 5; i++) {
        for (const f of page.frames()) {
            const clicked = await f.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
                const no = btns.find(b => /^no$/i.test((b.value || b.innerText || '').trim()));
                if (no) { no.click(); return true; }
                return false;
            }).catch(() => false);
            if (clicked) { await sleep(2000); break; }
        }
        await sleep(1000);
    }

    // Click Cerrar para volver a la grilla
    for (const f of page.frames()) {
        await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
            const cerrar = btns.find(b => /cerrar/i.test(b.value || b.innerText || ''));
            if (cerrar) cerrar.click();
        }).catch(() => {});
    }
    await sleep(3000);

    console.log('[AFILIACION] ✅ Proceso de afiliación completado');
    return true;
}

// ── Dar de baja la afiliación ─────────────────────────────────
async function bajaAfiliado(page, grillaFrame, rowIndex) {
    await abrirPropiedades(page, grillaFrame, rowIndex);

    // Pestaña Afiliado
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            const tabs = Array.from(document.querySelectorAll('a, span, div, td, li'));
            const tab = tabs.find(el => /^afiliado$/i.test((el.innerText || el.textContent || '').trim()));
            if (tab) { tab.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) { await sleep(2000); break; }
    }

    // Click "Baja Afiliado"
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button, a'));
            const btn = btns.find(b => /baja\s*afiliado/i.test(b.value || b.innerText || b.textContent || ''));
            if (btn) { btn.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) { await sleep(3000); break; }
    }

    // Confirmar Aceptar
    for (const f of page.frames()) {
        await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
            const btn = btns.find(b => /^aceptar$/i.test((b.value || b.innerText || '').trim()));
            if (btn) btn.click();
        }).catch(() => {});
    }
    await sleep(3000);

    // Modal imprimir → NO
    for (const f of page.frames()) {
        await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
            const no = btns.find(b => /^no$/i.test((b.value || b.innerText || '').trim()));
            if (no) no.click();
        }).catch(() => {});
    }
    await sleep(2000);

    // Cerrar
    for (const f of page.frames()) {
        await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
            const cerrar = btns.find(b => /cerrar/i.test(b.value || b.innerText || ''));
            if (cerrar) cerrar.click();
        }).catch(() => {});
    }
    await sleep(2000);
    console.log('[BAJA AFILIADO] ✅ Completado');
}

// ── Click en legajo de la grilla ──────────────────────────────
async function clickLegajo(page, grillaFrame, index) {
    const frame = grillaFrame || page;
    await frame.evaluate((idx) => {
        const rows = Array.from(document.querySelectorAll('tr')).filter(r =>
            !r.querySelector('th') && r.querySelectorAll('td').length >= 2);
        if (!rows[idx]) return;
        const link = rows[idx].querySelector('a');
        if (link) { link.click(); return; }
        rows[idx].click();
    }, index);
    await sleep(5000);
}

// ── Click Alta de crédito ─────────────────────────────────────
async function clickAltaCredito(page) {
    for (const f of page.frames()) {
        const clicked = await f.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input[type="button"], button, input[type="submit"], a'));
            const alta = btns.find(b => /^alta$/i.test((b.value || b.innerText || '').trim()));
            if (alta) { alta.click(); return true; }
            return false;
        }).catch(() => false);
        if (clicked) { await sleep(4000); return true; }
    }
    return false;
}

// ── Binary search del cupo ────────────────────────────────────
async function binarySearchCupo(page, min, max) {
    let bajo = min, alto = max, cupoMaximo = 0, iteraciones = 0;

    async function probarMonto(monto) {
        for (const f of page.frames()) {
            const ok = await f.evaluate((m) => {
                const input = document.querySelector('input[name="importe_cuota"]') ||
                              document.querySelector('input[name="monto"]') ||
                              document.querySelector('input[name="Monto"]') ||
                              document.querySelector('input[name="Importe"]');
                if (!input) return false;
                input.value = m.toString();
                input.dispatchEvent(new Event('change', { bubbles: true }));
                const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
                const btn = btns.find(b => /consultar|control|verificar/i.test(b.value || b.innerText || ''));
                if (btn) { btn.click(); return true; }
                return false;
            }, monto).catch(() => false);
            if (ok) { await sleep(4000); return true; }
        }
        return false;
    }

    async function esAprobado() {
        for (const f of page.frames()) {
            const result = await f.evaluate(() => {
                const body = document.body?.innerText || '';
                if (/aprobado|autorizado|ok|disponible|aceptado/i.test(body)) return 'ok';
                if (/rechazado|supera|excede|no disponible|insuficiente/i.test(body)) return 'nok';
                return 'unknown';
            }).catch(() => 'unknown');
            if (result !== 'unknown') return result === 'ok';
        }
        return false;
    }

    while (bajo <= alto && iteraciones < 12) {
        iteraciones++;
        const medio = Math.floor((bajo + alto) / 2);
        console.log(`[BINARY] iter=${iteraciones} rango=[${bajo},${alto}] prueba=${medio}`);
        if (!await probarMonto(medio)) break;
        const aprobado = await esAprobado();
        console.log(`[BINARY] monto=${medio} aprobado=${aprobado}`);
        if (aprobado) { cupoMaximo = medio; bajo = medio + 1; }
        else { alto = medio - 1; }
    }

    return { cupoMaximo, iteraciones };
}

// ============================================================
// LOGIN HELPER
// ============================================================
async function loginConRetry(page, browser, usuario, password) {
    let loggedIn = false;
    for (let intento = 1; intento <= 3 && !loggedIn; intento++) {
        console.log(`[LOGIN] Intento ${intento}/3...`);
        try { loggedIn = await intentarLogin(page, browser, usuario, password); }
        catch(e) { console.log(`[LOGIN] Error: ${e.message}`); }
    }
    return loggedIn;
}

// ============================================================
// 1. BCRA
// ============================================================
app.post('/api/consultar-bcra', async (req, res) => {
    try {
        const { documento, sexo } = req.body;
        const cuil = documento.length >= 10 ? documento : calcularCuil(documento, sexo);
        const response = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuil}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }, validateStatus: s => s < 500
        });
        if (response.status === 200) {
            const data = response.data;
            let bcra = { error: false, tieneDeudas: false, peorSituacion: "1", nombre: "", cuil, detalles: [] };
            if (data.results) {
                bcra.nombre = data.results.denominacion || "";
                const vistas = new Set(); let peor = 1;
                for (const p of (data.results.periodos || [])) for (const e of (p.entidades || [])) {
                    const k = `${e.entidad}-${p.periodo}`;
                    if (!vistas.has(k)) { vistas.add(k); bcra.detalles.push({ entidad: e.entidad, situacion: e.situacion.toString(), monto: (e.monto||0)*1000, periodo: p.periodo }); if (e.situacion > peor) peor = e.situacion; }
                }
                if (bcra.detalles.length > 0) { bcra.tieneDeudas = true; bcra.peorSituacion = peor.toString(); }
            }
            return res.json({ success: true, bcra });
        } else if (response.status === 404) return res.json({ success: true, bcra: { error: false, tieneDeudas: false, peorSituacion: "1", cuil } });
        return res.json({ success: false, error: true, mensaje: `HTTP ${response.status}` });
    } catch (e) { return res.json({ success: false, error: true, mensaje: e.message }); }
});

// ============================================================
// 2. JUICIOS
// ============================================================
app.post('/api/consultar-juicios', async (req, res) => {
    let { dni } = req.body;
    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser;
    try {
        browser = await launchBrowser();
        const page = await browser.newPage();
        await page.goto('https://www2.jus.mendoza.gov.ar/registros/rju/index.php', { waitUntil: 'domcontentloaded' });
        await page.evaluate((doc) => { const i = document.querySelectorAll('input[type="text"]'); if (i.length > 0) i[i.length-1].value = doc; if (document.forms[0]) document.forms[0].submit(); }, dniLimpio);
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        const juicios = await page.evaluate(() => {
            const filas = Array.from(document.querySelectorAll('table tr')).slice(1);
            return { tieneRegistros: false, registros: filas.map(f => { const c = f.querySelectorAll('td'); if (c.length >= 6) { let l = f.querySelector('a')?.getAttribute('href') || null; if (l && !l.startsWith('http')) l = 'https://www2.jus.mendoza.gov.ar/registros/rju/' + l.replace(/^\//, ''); return { expediente: c[0].innerText.trim(), nombre: c[1].innerText.trim(), tipo: c[2].innerText.trim(), tribunal: c[3].innerText.trim(), fecha: c[4].innerText.trim(), linkCertificado: l }; } return null; }).filter(r => r && (r.tipo.toUpperCase().includes('QUIEBRA') || r.tipo.toUpperCase().includes('CONCURSO'))) };
        });
        juicios.tieneRegistros = juicios.registros.length > 0;
        res.json({ success: true, judicial: juicios });
    } catch (e) { res.status(200).json({ success: false, error: true, mensaje: e.message }); }
    finally { if (browser) await browser.close(); }
});

// ============================================================
// 3. SIMULAR CUPO — v12: afiliación automática si Socio=NO
// ============================================================
app.post('/api/simular-cupo', async (req, res) => {
    let { dni, usuario, password, sexo, min = 1000, max = 500000 } = req.body;
    if (!dni || !usuario || !password) return res.json({ success: false, error: true, mensaje: 'Faltan: dni, usuario, password' });
    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser, paso = 'Iniciando';

    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[CUAD v12] DNI=${dniLimpio} — ${new Date().toISOString()}`);
        browser = await launchBrowser();
        const page = await browser.newPage();
        await configurarPagina(page);

        paso = 'Login';
        if (!await loginConRetry(page, browser, usuario, password)) {
            await browser.close();
            return res.json({ success: false, error: true, mensaje: 'Login falló después de 3 intentos' });
        }
        console.log('[LOGIN] ✅');

        paso = 'Tab Personas';
        const { dniFrame, dniSelector } = await irAPersonas(page);
        if (!dniFrame) { await browser.close(); return res.json({ success: false, error: true, mensaje: 'Sin input DNI' }); }

        paso = 'Buscar DNI';
        const { grillaHtml, grillaFrame } = await buscarDNI(page, dniFrame, dniSelector, dniLimpio);
        console.log(`[BUSCAR] Grilla: ${grillaHtml.length}c`);
        // DEBUG: primeros 4000 chars de la grilla
        console.log(`[GRILLA RAW] ${grillaHtml.substring(0, 4000)}`);

        if (!grillaHtml || grillaHtml.length < 100)
            { await browser.close(); return res.json({ success: false, error: true, mensaje: 'Grilla vacía' }); }
        if (/no se encontr|0 registro|sin resultado/i.test(grillaHtml))
            { await browser.close(); return res.json({ success: true, noRegistra: true, cupoMaximo: 0 }); }

        paso = 'Parsear grilla';
        const legajos = parsearGrilla(grillaHtml);
        console.log(`[GRILLA] ${legajos.length} legajos: ${JSON.stringify(legajos.map(l => ({ n: l.nombre, socio: l.esSocio })))}`);
        if (legajos.length === 0) { await browser.close(); return res.json({ success: true, noRegistra: true, cupoMaximo: 0 }); }

        const legajo = legajos[0];
        let afiliadoAhora = false;

        // ── Si no es socio → afiliar ──
        if (!legajo.esSocio) {
            paso = 'Afiliar persona';
            console.log(`[AFILIACION] Socio=NO, iniciando afiliación...`);
            await abrirPropiedades(page, grillaFrame, legajo.index);
            await afiliarPersona(page);
            afiliadoAhora = true;

            // Re-buscar para refrescar grilla con Socio=SI
            paso = 'Re-buscar post-afiliacion';
            const { dniFrame: df2, dniSelector: ds2 } = await irAPersonas(page);
            if (df2) {
                const { grillaHtml: gh2, grillaFrame: gf2 } = await buscarDNI(page, df2, ds2, dniLimpio);
                const legajos2 = parsearGrilla(gh2);
                if (legajos2.length > 0) {
                    Object.assign(legajo, legajos2[0]);
                    Object.assign(grillaFrame || {}, gf2 || {});
                }
            }
        }

        // ── Click legajo → Alta ──
        paso = 'Click legajo';
        await clickLegajo(page, grillaFrame, legajo.index);

        paso = 'Click Alta crédito';
        await clickAltaCredito(page);

        // ── Binary search ──
        paso = 'Binary search cupo';
        const { cupoMaximo, iteraciones } = await binarySearchCupo(page, min, max);
        console.log(`[CUPO] ✅ cupoMaximo=${cupoMaximo} iteraciones=${iteraciones} afiliadoAhora=${afiliadoAhora}`);

        await browser.close();
        return res.json({
            success: true,
            cupoMaximo,
            iteraciones,
            nombre: legajo.nombre,
            afiliadoAhora,     // el dashboard usa esto para saber que si el crédito no prospera hay que dar de baja
            legajosEncontrados: legajos.length,
        });

    } catch (err) {
        console.error(`[ERROR] ${paso}: ${err.message}`);
        if (browser) await browser.close().catch(() => {});
        return res.json({ success: false, error: true, mensaje: `Paso: ${paso} — ${err.message}` });
    }
});

// ============================================================
// 4. EJECUTAR ALTA REAL
// ============================================================
app.post('/api/ejecutar-alta', async (req, res) => {
    let { dni, usuario, password, sexo, montoCuota } = req.body;
    if (!dni || !usuario || !password || !montoCuota)
        return res.json({ success: false, error: true, mensaje: 'Faltan: dni, usuario, password, montoCuota' });
    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser, paso = 'Iniciando';

    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[ALTA REAL v12] DNI=${dniLimpio} monto=${montoCuota}`);
        browser = await launchBrowser();
        const page = await browser.newPage();
        await configurarPagina(page);

        paso = 'Login';
        if (!await loginConRetry(page, browser, usuario, password)) {
            await browser.close(); return res.json({ success: false, error: true, mensaje: 'Login falló' });
        }

        paso = 'Tab Personas';
        const { dniFrame, dniSelector } = await irAPersonas(page);
        if (!dniFrame) { await browser.close(); return res.json({ success: false, error: true, mensaje: 'Sin input DNI' }); }

        paso = 'Buscar DNI';
        const { grillaHtml, grillaFrame } = await buscarDNI(page, dniFrame, dniSelector, dniLimpio);
        if (!grillaHtml || /no se encontr|0 registro/i.test(grillaHtml))
            { await browser.close(); return res.json({ success: false, error: true, mensaje: 'Persona no encontrada' }); }

        const legajos = parsearGrilla(grillaHtml);
        if (legajos.length === 0) { await browser.close(); return res.json({ success: false, error: true, mensaje: 'Sin legajos' }); }
        const legajo = legajos[0];

        paso = 'Click legajo';
        await clickLegajo(page, grillaFrame, legajo.index);

        paso = 'Click Alta crédito';
        await clickAltaCredito(page);

        paso = 'Ingresar monto y confirmar';
        for (const f of page.frames()) {
            const ok = await f.evaluate((m) => {
                const input = document.querySelector('input[name="importe_cuota"]') ||
                              document.querySelector('input[name="monto"]') ||
                              document.querySelector('input[name="Monto"]');
                if (!input) return false;
                input.value = m.toString();
                input.dispatchEvent(new Event('change', { bubbles: true }));
                const btns = Array.from(document.querySelectorAll('input[type="button"], button'));
                const aceptar = btns.find(b => /^aceptar$/i.test((b.value || b.innerText || '').trim()));
                if (aceptar) { aceptar.click(); return true; }
                return false;
            }, montoCuota).catch(() => false);
            if (ok) break;
        }
        await sleep(6000);

        // Capturar código CAD
        let codigoCAD = '';
        for (const f of page.frames()) {
            const cad = await f.evaluate(() => {
                const body = document.body?.innerText || '';
                const match = body.match(/CAD[:\s#]*([A-Z0-9-]{4,20})/i) ||
                              body.match(/[Cc][óo]digo[:\s]*([A-Z0-9-]{4,20})/);
                return match ? match[1] : '';
            }).catch(() => '');
            if (cad) { codigoCAD = cad; break; }
        }

        const screenshotB64 = await page.screenshot({ encoding: 'base64', fullPage: false }).catch(() => '');
        console.log(`[ALTA REAL] ✅ CAD=${codigoCAD}`);
        await browser.close();
        return res.json({ success: true, codigoCAD, screenshotBase64: screenshotB64, nombre: legajo.nombre });

    } catch (err) {
        console.error(`[ERROR ALTA] ${paso}: ${err.message}`);
        if (browser) await browser.close().catch(() => {});
        return res.json({ success: false, error: true, mensaje: `Paso: ${paso} — ${err.message}` });
    }
});

// ============================================================
// 5. BAJA AFILIADO (cuando el crédito no prospera)
// ============================================================
app.post('/api/baja-afiliado', async (req, res) => {
    let { dni, usuario, password } = req.body;
    if (!dni || !usuario || !password)
        return res.json({ success: false, error: true, mensaje: 'Faltan: dni, usuario, password' });
    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser, paso = 'Iniciando';

    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[BAJA AFILIADO v12] DNI=${dniLimpio}`);
        browser = await launchBrowser();
        const page = await browser.newPage();
        await configurarPagina(page);

        paso = 'Login';
        if (!await loginConRetry(page, browser, usuario, password)) {
            await browser.close(); return res.json({ success: false, error: true, mensaje: 'Login falló' });
        }

        paso = 'Tab Personas';
        const { dniFrame, dniSelector } = await irAPersonas(page);
        if (!dniFrame) { await browser.close(); return res.json({ success: false, error: true, mensaje: 'Sin input DNI' }); }

        paso = 'Buscar DNI';
        const { grillaHtml, grillaFrame } = await buscarDNI(page, dniFrame, dniSelector, dniLimpio);
        const legajos = parsearGrilla(grillaHtml);
        if (legajos.length === 0) { await browser.close(); return res.json({ success: false, error: true, mensaje: 'Persona no encontrada' }); }

        paso = 'Baja afiliado';
        await bajaAfiliado(page, grillaFrame, legajos[0].index);

        console.log('[BAJA AFILIADO] ✅');
        await browser.close();
        return res.json({ success: true, nombre: legajos[0].nombre });

    } catch (err) {
        console.error(`[ERROR BAJA] ${paso}: ${err.message}`);
        if (browser) await browser.close().catch(() => {});
        return res.json({ success: false, error: true, mensaje: `Paso: ${paso} — ${err.message}` });
    }
});

app.get('/', (req, res) => res.json({ status: 'ok', version: '12' }));
app.get('/api/status', (req, res) => res.json({ ok: true, version: '12' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🤖 Bot v12 — afiliación automática — Puerto ${PORT}`));
