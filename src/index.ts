import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium, Browser, Page } from 'playwright-chromium';

const app = express();
const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
    console.log(`Servidor HTTP escuchando en el puerto ${port}`);
});

const wss = new WebSocketServer({ server });
console.log('Servidor de WebSockets iniciado.');

wss.on('connection', (ws) => {
    console.log('Cliente conectado.');
    let browser: Browser | null = null;
    let page: Page | null = null;

    ws.on('message', async (message) => {
        try {
            const request = JSON.parse(message.toString());
            console.log('Mensaje recibido:', request.type);

            if (request.type === 'GET_CAPTCHA') {
                const { uuid, rfcEmisor, rfcReceptor } = request.data;
                
                console.log(`Iniciando scraping para UUID: ${uuid}`);
                browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                page = await browser.newPage();
                await page.goto('https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx');

                await page.locator('#ctl00_MainContent_TxtUUID').type(uuid);
                await page.locator('#ctl00_MainContent_TxtRfcEmisor').type(rfcEmisor);
                await page.locator('#ctl00_MainContent_TxtRfcReceptor').type(rfcReceptor);

                const captchaElement = await page.locator('#ctl00_MainContent_ImgCaptcha');
                await captchaElement.waitFor({ state: 'visible', timeout: 15000 });
                const captchaScreenshot = await captchaElement.screenshot();

                ws.send(JSON.stringify({
                    type: 'CAPTCHA_READY',
                    payload: { captchaImage: captchaScreenshot.toString('base64') }
                }));
            }
            else if (request.type === 'SOLVE_CAPTCHA' && page) {
                const { captchaSolution } = request.data;
                console.log(`Solución de CAPTCHA recibida: ${captchaSolution}`);
                
                await page.locator('#ctl00_MainContent_TxtCaptchaNumbers').type(captchaSolution);
                await page.locator('#ctl00_MainContent_BtnBusqueda').click();

                // ✅ LÓGICA SIMPLIFICADA: Esperamos directamente el panel de resultados.
                await page.waitForSelector('#ctl00_MainContent_PnlResultados', { state: 'visible', timeout: 15000 });
                
                console.log('¡CAPTCHA correcto! Extrayendo datos...');

                // ✅ IDS CORREGIDOS: Usando los selectores que proporcionaste.
                const getText = async (page: Page, selector: string) => (await page.locator(selector).first().textContent())?.trim() ?? '';
                const scrapedData = {
                    rfcEmisor: await getText(page, '#ctl00_MainContent_LblRfcEmisor'),
                    nombreEmisor: await getText(page, '#ctl00_MainContent_LblNombreEmisor'),
                    rfcReceptor: await getText(page, '#ctl00_MainContent_LblRfcReceptor'),
                    nombreReceptor: await getText(page, '#ctl00_MainContent_LblNombreReceptor'),
                    folioFiscal: await getText(page, '#ctl00_MainContent_LblUuid'),
                    fechaExpedicion: await getText(page, '#ctl00_MainContent_LblFechaEmision'),
                    totalCfdi: await getText(page, '#ctl00_MainContent_LblMonto'),
                    efectoComprobante: await getText(page, '#ctl00_MainContent_LblEfectoComprobante'),
                    estadoCfdi: await getText(page, '#ctl00_MainContent_LblEstado'),
                    estatusCancelacion: await getText(page, '#ctl00_MainContent_LblEsCancelable'), // Corregí el typo
                };

                ws.send(JSON.stringify({
                    type: 'SCRAPE_SUCCESS',
                    payload: scrapedData
                }));

                if (browser) await browser.close();
                ws.close();
            }

        } catch (error) {
            let errorMessage = 'Ocurrió un error desconocido en el servidor.';
            if (error instanceof Error) {
                errorMessage = error.message.includes('Timeout') 
                    ? 'El CAPTCHA es incorrecto o la página del SAT no respondió.' 
                    : error.message;
            }
            console.error('Error en la conexión WebSocket:', errorMessage);
            ws.send(JSON.stringify({ type: 'ERROR', payload: { message: errorMessage } }));
            if (browser) await browser.close();
            ws.close();
        }
    });

    ws.on('close', async () => {
        console.log('Cliente desconectado.');
        if (browser) await browser.close();
    });
});

