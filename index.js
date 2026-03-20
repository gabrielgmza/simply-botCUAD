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

// ============================================================
// Intento completo de login: navegar → captcha → submit → verificar
// Retorna true si principal.asp cargó, false si captcha incorrecto
// ============================================================
async function intentarLogin(page, browser, usuario, password) {
    // Capturar BMP via network
    let captchaBmp = null;
    const captchaHandler = async (resp) => {
        if (resp.url().includes('aspcaptcha.asp')) {
            try { captchaBmp = await resp.buffer(); } catch(e) {}
        }
    };
    page.on('response', captchaHandler);

    // Navegar a / → login.asp
    await page.goto('https://descuentos.mendoza.gov.ar/', { waitUntil: 'networkidle2' });
    await sleep(3000);
    if (page.url().includes('logout_resolucion')) throw new Error('Screen check falló');
    if (!page.url().includes('login.asp')) {
        await page.waitForNavigation({ timeout: 10000 }).catch(() => {});
        if (!page.url().includes('login.asp'))
            await page.goto('https://descuentos.mendoza.gov.ar/login.asp', { waitUntil: 'networkidle2' });
    }

    // Esperar Modo=M
    let loginFrame = null;
    for (let i = 0; i < 20 && !loginFrame; i++) { await sleep(1500); loginFrame = page.frames().find(f => f.url().includes('Modo=M')); }
    if (!loginFrame) throw new Error('Modo=M no apareció');

    // Esperar captcha
    for (let i = 0; i < 10 && !captchaBmp; i++) await sleep(500);
    page.off('response', captchaHandler);
    console.log(`  captcha: ${captchaBmp ? captchaBmp.length + 'b' : 'NO'}`);

    // Resolver captcha
    const captchaSol = await resolverCaptcha(captchaBmp, browser);
    if (!captchaSol) throw new Error('Captcha no resuelto');
    console.log(`  captcha="${captchaSol}"`);

    // Llenar form
    await loginFrame.waitForSelector('#user', { timeout: 10000 });
    await loginFrame.click('#user', { clickCount: 3 }); await loginFrame.type('#user', usuario, { delay: 60 });
    await loginFrame.click('#password', { clickCount: 3 }); await loginFrame.type('#password', password, { delay: 60 });
    if (await loginFrame.$('#txtCaptcha')) { await loginFrame.click('#txtCaptcha', { clickCount: 3 }); await loginFrame.type('#txtCaptcha', captchaSol, { delay: 30 }); }
    const mac = await loginFrame.$eval('#hCadMac', el => el.value).catch(() => '');
    if (!mac || mac === '0') await loginFrame.$eval('#hCadMac', (el, v) => el.value = v, String(usuario.length + password.length + 6));

    // Interceptar "/" → principal.asp + Submit
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

    // Verificar si principal.asp cargó
    await sleep(5000);
    const html = await page.content().catch(() => '');
    const hasSystem = html.includes('Tab_Registra');
    const ctk = (await page.cookies()).find(c => c.name === 'ctk')?.value || '?';
    console.log(`  resultado: hasSystem=${hasSystem} ctk=${ctk} url=${page.url()}`);

    return hasSystem;
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
// 3. SIMULAR CUPO — v10 con retry de captcha
// ============================================================
app.post('/api/simular-cupo', async (req, res) => {
    let { dni, usuario, password, min = 1000, max = 500000 } = req.body;
    if (!dni || !usuario || !password) return res.json({ success: false, error: true, mensaje: 'Faltan: dni, usuario, password' });
    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser, paso = 'Iniciando';

    try {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`[CUAD v10] DNI=${dni} user=${usuario} — ${new Date().toISOString()}`);
        browser = await launchBrowser();
        const page = await browser.newPage();
        await configurarPagina(page);

        // ── LOGIN CON RETRY (hasta 3 intentos por captcha incorrecto) ──
        paso = 'Login';
        let loggedIn = false;
        for (let intento = 1; intento <= 3 && !loggedIn; intento++) {
            console.log(`[LOGIN] Intento ${intento}/3...`);
            try {
                loggedIn = await intentarLogin(page, browser, usuario, password);
                if (!loggedIn) {
                    console.log(`[LOGIN] Intento ${intento} falló (captcha incorrecto), reintentando...`);
                }
            } catch(e) {
                console.log(`[LOGIN] Intento ${intento} error: ${e.message}`);
            }
        }

        if (!loggedIn) {
            await browser.close();
            return res.json({ success: false, error: true, mensaje: 'Login falló después de 3 intentos de captcha' });
        }

        console.log('[LOGIN] ✅ ¡Sistema cargado!');

        // ── BUSCAR PERSONA ──
        paso = 'Buscar persona';
        await sleep(5000);

        console.log(`[7] Frames: ${page.frames().map(f => f.name() + '=' + f.url().split('/').pop()).join(', ')}`);

        const tabResult = await page.evaluate(() => {
            try { if (typeof Tab_Click === 'function') { Tab_Click('Personas'); return 'OK'; } return 'no fn'; } catch(e) { return e.message; }
        });
        console.log(`[7] Tab_Click: ${tabResult}`);
        await sleep(8000);

        console.log(`[7] Frames post-tab: ${page.frames().map(f => f.name() + '=' + f.url().split('/').pop()).join(', ')}`);

        // Buscar input DNI — el campo es Per_NroDoc en el frame iPersonas
        let dniFrame = null, dniSelector = null;
        const selectors = [
            'input[name="Per_NroDoc"]', 'input[name="dni"]', 'input[name="Documento"]',
            'input[name="nroDocumento"]', 'input[name="nro_doc"]',
        ];

        // Buscar primero en iPersonas específicamente
        const iPersonas = page.frames().find(f => f.name() === 'iPersonas');
        if (iPersonas) {
            for (const sel of selectors) {
                if (await iPersonas.$(sel).catch(() => null)) { dniFrame = iPersonas; dniSelector = sel; break; }
            }
        }

        // Fallback: buscar en todos los frames
        if (!dniFrame) {
            for (let i = 0; i < 5 && !dniFrame; i++) {
                for (const f of page.frames()) {
                    for (const sel of selectors) {
                        if (await f.$(sel).catch(() => null)) { dniFrame = f; dniSelector = sel; break; }
                    }
                    if (dniFrame) break;
                }
                if (!dniFrame) await sleep(3000);
            }
        }

        if (!dniFrame) {
            // Log HTML de frames de personas específicamente
            for (const name of ['iPersonas', 'ifrComandosPersonas', 'ifrGrillaPersonas', 'ifrDetallePersonas']) {
                const f = page.frames().find(f => f.name() === name);
                if (f) {
                    const h = await f.content().catch(() => '');
                    console.log(`[7] ${name} (${h.length}c): ${h.substring(0, 500)}`);
                }
            }
            await browser.close();
            return res.json({ success: false, error: true, mensaje: 'Sin input DNI' });
        }

        console.log(`[7] ✓ DNI: ${dniSelector} en ${dniFrame.name()}`);

        // Limpiar y escribir DNI
        await dniFrame.evaluate((sel) => { const el = document.querySelector(sel); if (el) { el.value = ''; el.focus(); } }, dniSelector);
        await dniFrame.type(dniSelector, dniLimpio, { delay: 50 });
        console.log(`[7] DNI ingresado: ${dniLimpio}`);

        // Click en Buscar — usar evaluate para llamar la función o submit del form
        await dniFrame.evaluate(() => {
            try {
                if (typeof Buscar === 'function') { Buscar(); return; }
                if (typeof Aceptar === 'function') { Aceptar(); return; }
                const form = document.getElementById('form1') || document.forms[0];
                if (form) {
                    const modo = document.getElementById('Modo');
                    if (modo) modo.value = 'Buscar';
                    form.submit();
                }
            } catch(e) { console.log('Submit error:', e.message); }
        });

        // Esperar resultado
        await sleep(8000);

        // Verificar resultado en la grilla
        const grillaFrame = page.frames().find(f => f.name() === 'ifrGrillaPersonas');
        if (grillaFrame) {
            const grillaHtml = await grillaFrame.content().catch(() => '');
            console.log(`[7] Grilla: ${grillaHtml.length}c snippet: ${grillaHtml.substring(0, 200)}`);
            const noResultados = grillaHtml.includes('no se encontraron') || grillaHtml.includes('0 registro');
            if (noResultados) {
                await browser.close();
                return res.json({ success: true, noRegistra: true, cupoMaximo: 0 });
            }
        }

        const body = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (body.includes("No se encontraron") || body.includes("no se encontraron") || body.includes("0 registro")) {
            await browser.close();
            return res.json({ success: true, noRegistra: true, cupoMaximo: 0 });
        }

        console.log('[7] Persona encontrada, continuando...');
        // TODO: Click en la persona de la grilla, luego Alta, luego búsqueda binaria
        // Por ahora retornamos éxito parcial para confirmar que el flujo funciona
        await browser.close();
        return res.json({ success: true, mensaje: '¡LOGIN + BÚSQUEDA EXITOSA! Persona encontrada.', paso: 'persona_encontrada', dni: dniLimpio });

    } catch (err) {
        console.error(`[ERROR] ${paso}: ${err.message}`);
        if (browser) await browser.close().catch(() => {});
        return res.json({ success: false, error: true, mensaje: `Paso: ${paso} — ${err.message}` });
    }
});

app.get('/', (req, res) => res.json({ status: 'ok', version: '10' }));
app.get('/api/status', (req, res) => res.json({ ok: true, version: '10' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`🤖 Bot v10 — captcha retry + interceptación — Puerto ${PORT}`));
