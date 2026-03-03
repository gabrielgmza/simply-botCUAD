const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const ac = require('@antiadmin/anticaptchaofficial');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
ac.setAPIKey(process.env.ANTICAPTCHA_KEY);

function calcularCuil(dni, sexo) {
    const dniStr = dni.padStart(8, '0');
    let prefijo = sexo === 'M' ? '20' : '27';
    const multiplicadores = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let base = prefijo + dniStr;
    let suma = 0;
    for (let i = 0; i < 10; i++) suma += parseInt(base[i]) * multiplicadores[i];
    let resto = suma % 11;
    let digito = 11 - resto;
    if (digito === 11) digito = 0;
    if (digito === 10) { prefijo = '23'; digito = sexo === 'M' ? 9 : 4; base = prefijo + dniStr; }
    return base + digito.toString();
}

// ---------------------------------------------------------
// 1. BCRA OFICIAL (Nueva API Open Finance v1.0)
// ---------------------------------------------------------
app.post('/api/consultar-bcra', async (req, res) => {
    try {
        const { documento, sexo } = req.body;
        const cuil = documento.length >= 10 ? documento : calcularCuil(documento, sexo);
        console.log(`[BCRA] Consultando CUIL: ${cuil} en la nueva API v1.0`);

        const response = await axios.get(`https://api.bcra.gob.ar/centraldedeudores/v1.0/Deudas/${cuil}`, {
            headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            validateStatus: function (status) { return status < 500; }
        });

        if (response.status === 200) {
            const data = response.data;
            let bcraData = { error: false, tieneDeudas: false, peorSituacion: "1", nombre: "", cuil: cuil, detalles: [] };
            
            if (data.results) {
                bcraData.nombre = data.results.denominacion || "";
                
                if (data.results.periodos && data.results.periodos.length > 0) {
                    const ultimoPeriodo = data.results.periodos[0];
                    
                    if (ultimoPeriodo.entidades && ultimoPeriodo.entidades.length > 0) {
                        bcraData.tieneDeudas = true;
                        bcraData.detalles = ultimoPeriodo.entidades.map(ent => ({
                            entidad: ent.entidad,
                            situacion: ent.situacion.toString(),
                            monto: ent.monto,
                            periodo: ultimoPeriodo.periodo
                        }));
                        bcraData.peorSituacion = Math.max(...ultimoPeriodo.entidades.map(d => parseInt(d.situacion))).toString();
                    }
                }
            }
            return res.json({ success: true, bcra: bcraData });
        } else if (response.status === 404) {
            return res.json({ success: true, bcra: { error: false, tieneDeudas: false, peorSituacion: "1", cuil } });
        } else {
            console.error(`[BCRA] Error HTTP: ${response.status}`);
            return res.json({ success: false, error: true, mensaje: `HTTP ${response.status}` });
        }
    } catch (e) {
        console.error(`[BCRA] Error interno: ${e.message}`);
        return res.json({ success: false, error: true, mensaje: e.message });
    }
});

// ---------------------------------------------------------
// 2. JUICIOS
// ---------------------------------------------------------
app.post('/api/consultar-juicios', async (req, res) => {
    let { dni } = req.body;
    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser;
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.goto('https://www2.jus.mendoza.gov.ar/registros/rju/index.php', { waitUntil: 'domcontentloaded' });
        
        await page.evaluate((doc) => {
            const inputs = document.querySelectorAll('input[type="text"]');
            if (inputs.length > 0) inputs[inputs.length - 1].value = doc; 
            if (document.forms[0]) document.forms[0].submit();
        }, dniLimpio);

        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

        const juiciosData = await page.evaluate(() => {
            const filas = Array.from(document.querySelectorAll('table tr')).slice(1);
            const registros = filas.map(fila => {
                const celdas = fila.querySelectorAll('td');
                if(celdas.length >= 6) {
                    const enlaceElem = fila.querySelector('a');
                    let linkDoc = enlaceElem ? enlaceElem.getAttribute('href') : null;
                    if(linkDoc && !linkDoc.startsWith('http')) {
                        linkDoc = 'https://www2.jus.mendoza.gov.ar/registros/rju/' + linkDoc.replace(/^\//, '');
                    }
                    return {
                        expediente: celdas[0].innerText.trim(),
                        nombre: celdas[1].innerText.trim(),
                        tipo: celdas[2].innerText.trim(),
                        tribunal: celdas[3].innerText.trim(),
                        fecha: celdas[4].innerText.trim(),
                        linkCertificado: linkDoc
                    };
                }
                return null;
            }).filter(r => r !== null && (r.tipo.toUpperCase().includes('QUIEBRA') || r.tipo.toUpperCase().includes('CONCURSO')));
            return { tieneRegistros: registros.length > 0, registros: registros };
        });

        res.json({ success: true, judicial: juiciosData });
    } catch (error) {
        res.status(200).json({ success: false, error: true, mensaje: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

// ---------------------------------------------------------
// 3. CUPO MENDOZA (solo simula, no confirma el Alta)
// ---------------------------------------------------------
app.post('/api/simular-cupo', async (req, res) => {
    let { dni, usuario, password, min = 1000, max = 500000 } = req.body;
    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser;
    let pasoActual = "Iniciando";
    
    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');
        
        pasoActual = "Cargando página de Login";
        await page.goto('https://descuentos.mendoza.gov.ar/login.asp', {waitUntil: 'domcontentloaded'});
        
        pasoActual = "Esperando formulario de Login";
        await page.waitForSelector('input[name="usuario"]', { timeout: 15000 });
        
        pasoActual = "Ingresando credenciales";
        await page.type('input[name="usuario"]', usuario);
        await page.type('input[name="password"]', password);
        
        const captchaLogin = await page.$('img#img_captcha');
        if (captchaLogin) {
            const solLogin = await ac.solveImage(await captchaLogin.screenshot({encoding:'base64'}), true);
            await page.type('input[name="codigo"]', solLogin);
        }
        await Promise.all([ page.waitForNavigation(), page.evaluate(() => document.forms[0].submit()) ]);

        pasoActual = "Buscar DNI";
        await page.goto('https://descuentos.mendoza.gov.ar/personas/buscar.asp', {waitUntil: 'domcontentloaded'});
        await page.waitForSelector('input[name="dni"]', { timeout: 10000 });
        await page.type('input[name="dni"]', dniLimpio);
        await Promise.all([ page.waitForNavigation(), page.evaluate(() => document.forms[0].submit()) ]);

        pasoActual = "Verificar existencia";
        const existe = await page.evaluate(() => !document.body.innerText.includes("No se encontraron resultados"));
        if (!existe) return res.json({ success: true, noRegistra: true });

        pasoActual = "Entrar al Legajo";
        await page.evaluate(() => {
            const fila = document.querySelector('table tr.fila_persona') || document.querySelector('tr[onclick]');
            if(fila) fila.click();
        });
        await page.waitForTimeout(1000);
        
        pasoActual = "Click en Botón Alta";
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input, button'));
            const btnAlta = btns.find(e => e.value === 'Alta');
            if(btnAlta) btnAlta.click();
        });
        await page.waitForTimeout(1000);

        pasoActual = "Resolviendo Captcha Alta";
        const captchaModal = await page.$('img#img_verificacion');
        if (captchaModal) {
            const solModal = await ac.solveImage(await captchaModal.screenshot({encoding:'base64'}), true);
            await page.type('input[name="verificacion"]', solModal);
        }

        pasoActual = "Búsqueda Binaria";
        let bajo = min, alto = max, cupoMaximo = 0, iteraciones = 0;
        while (bajo <= alto && iteraciones < 15) {
            iteraciones++;
            let medio = Math.floor((bajo + alto) / 2);
            await page.click('input[name="importe_cuota"]', { clickCount: 3 });
            await page.keyboard.press('Backspace');
            await page.type('input[name="importe_cuota"]', medio.toString());
            
            await page.evaluate(() => {
                const btn = Array.from(document.querySelectorAll('input')).find(e => e.value === 'Control');
                if(btn) btn.click();
            });
            await page.waitForTimeout(1500);

            const resultado = await page.evaluate(() => {
                const txt = document.body.innerText;
                if (txt.includes("ESTÁ POR GENERAR") || txt.includes("Puede generar")) return 'OK';
                if (txt.includes("no permitidos") || txt.includes("excede")) return 'ERROR';
                return 'TIMEOUT';
            });

            if (resultado === 'OK') {
                cupoMaximo = medio; bajo = medio + 1;
                await page.evaluate(() => { const b = Array.from(document.querySelectorAll('input')).find(e => e.value === 'Cancelar' || e.value === 'Cerrar'); if(b) b.click(); });
            } else {
                alto = medio - 1;
                if (resultado === 'ERROR') await page.evaluate(() => { const b = Array.from(document.querySelectorAll('input')).find(e => e.value === 'Cerrar' || e.value === 'Aceptar'); if(b) b.click(); });
            }
        }

        res.json({ success: true, cupoMaximo, noRegistra: false, iteraciones });
    } catch (error) {
        res.status(200).json({ success: false, error: true, mensaje: `Paso: ${pasoActual}` });
    } finally {
        if (browser) await browser.close();
    }
});

// ---------------------------------------------------------
// 4. EJECUTAR ALTA REAL (confirma el descuento en el recibo)
// ---------------------------------------------------------
app.post('/api/ejecutar-alta', async (req, res) => {
    let { dni, montoCuota, usuario, password } = req.body;

    if (!dni || !montoCuota || !usuario || !password) {
        return res.status(400).json({ success: false, error: "Faltan parametros: dni, montoCuota, usuario, password" });
    }

    const dniLimpio = dni.length > 8 ? dni.substring(2, dni.length - 1) : dni;
    let browser;
    let pasoActual = "Iniciando";

    try {
        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

        // FASE 1: LOGIN
        pasoActual = "Login";
        await page.goto('https://descuentos.mendoza.gov.ar/login.asp', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('input[name="usuario"]', { timeout: 15000 });
        await page.type('input[name="usuario"]', usuario);
        await page.type('input[name="password"]', password);
        const captchaLogin = await page.$('img#img_captcha');
        if (captchaLogin) {
            const solLogin = await ac.solveImage(await captchaLogin.screenshot({ encoding: 'base64' }), true);
            await page.type('input[name="codigo"]', solLogin);
        }
        await Promise.all([ page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.evaluate(() => document.forms[0].submit()) ]);

        // FASE 2: BUSCAR EMPLEADO
        pasoActual = "Buscar empleado";
        await page.goto('https://descuentos.mendoza.gov.ar/personas/buscar.asp', { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('input[name="dni"]', { timeout: 10000 });
        await page.type('input[name="dni"]', dniLimpio);
        await Promise.all([ page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.evaluate(() => document.forms[0].submit()) ]);

        const existe = await page.evaluate(() => !document.body.innerText.includes("No se encontraron resultados"));
        if (!existe) return res.json({ success: false, noRegistra: true, error: "El DNI no registra como empleado publico." });

        pasoActual = "Entrar al legajo";
        await page.evaluate(() => {
            const fila = document.querySelector('table tr.fila_persona') || document.querySelector('tr[onclick]');
            if (fila) fila.click();
        });
        await page.waitForTimeout(1500);

        // FASE 3: ABRIR MODAL ALTA
        pasoActual = "Abrir modal Alta";
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input, button'));
            const btnAlta = btns.find(e => e.value === 'Alta');
            if (btnAlta) btnAlta.click();
        });
        await page.waitForTimeout(2000);

        // FASE 4: SEGUNDO CAPTCHA
        pasoActual = "Captcha modal";
        const captchaModal = await page.$('img#img_verificacion');
        if (captchaModal) {
            const solModal = await ac.solveImage(await captchaModal.screenshot({ encoding: 'base64' }), true);
            await page.waitForSelector('input[name="verificacion"]', { timeout: 10000 });
            await page.type('input[name="verificacion"]', solModal);
        }

        // FASE 5: INGRESAR MONTO Y VALIDAR
        pasoActual = "Ingresar monto";
        await page.waitForSelector('input[name="importe_cuota"]', { timeout: 10000 });
        await page.click('input[name="importe_cuota"]', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('input[name="importe_cuota"]', Math.round(montoCuota).toString());

        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('input')).find(e => e.value === 'Control');
            if (btn) btn.click();
        });
        await page.waitForTimeout(2000);

        const textoControl = await page.evaluate(() => document.body.innerText);
        if (textoControl.includes("excede") || textoControl.includes("no permitidos")) {
            return res.json({ success: false, error: "El monto solicitado excede el cupo disponible del empleado." });
        }

        // FASE 6: CONFIRMAR ALTA (presionar Generar en lugar de Cancelar)
        pasoActual = "Confirmar Alta";
        await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll('input, button'));
            const btnConfirmar = btns.find(e =>
                ['GENERAR', 'CONFIRMAR', 'ACEPTAR', 'GUARDAR'].includes((e.value || e.textContent || '').trim().toUpperCase())
            );
            if (btnConfirmar) btnConfirmar.click();
        });
        await page.waitForTimeout(3000);

        // FASE 7: CAPTURAR COMPROBANTE
        pasoActual = "Capturar comprobante";
        const textoPagina = await page.evaluate(() => document.body.innerText);
        const screenshotB64 = await page.screenshot({ encoding: 'base64', fullPage: true });

        // Intentar extraer codigo CAD del texto de la pagina
        const matchCodigo = textoPagina.match(/[Cc][Óó]digo[:\s#]*([A-Z0-9\-]+)/);
        const matchNro    = textoPagina.match(/[Nn][úu]mero[:\s#]*([A-Z0-9\-]+)/);
        const codigoCAD   = matchCodigo?.[1] || matchNro?.[1] || null;

        return res.json({
            success: true,
            codigoCAD,
            dni: dniLimpio,
            montoCuota: Math.round(montoCuota),
            screenshotB64,
        });

    } catch (error) {
        console.error(`[ejecutar-alta] Error en paso "${pasoActual}": ${error.message}`);
        return res.status(200).json({ success: false, error: `Fallo en paso: ${pasoActual} — ${error.message}` });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(8080, () => console.log(`Bot Listo con Open Finance API v1.0`));
