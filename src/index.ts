import express from 'express';
import { WebSocketServer } from 'ws';
import { chromium, Browser, Page } from 'playwright-chromium';

const app = express();
const port = process.env.PORT || 3000;

// Iniciamos el servidor HTTP
const server = app.listen(port, () => {
    console.log(`Servidor HTTP escuchando en el puerto ${port}`);
});

// Iniciamos el servidor de WebSockets sobre el servidor HTTP
const wss = new WebSocketServer({ server });
console.log('Servidor de WebSockets iniciado.');

// Esta función se ejecuta cada vez que un nuevo cliente (nuestra app) se conecta.
wss.on('connection', (ws) => {
    console.log('Cliente conectado.');

    let browser: Browser | null = null;
    let page: Page | null = null;

    // Esta función se ejecuta cada vez que recibimos un mensaje del cliente.
    ws.on('message', async (message) => {
        try {
            const request = JSON.parse(message.toString());
            console.log('Mensaje recibido:', request.type);

            // --- FLUJO PASO 1: Iniciar el proceso y obtener el CAPTCHA ---
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

                // Enviamos la imagen del CAPTCHA de vuelta al cliente
                ws.send(JSON.stringify({
                    type: 'CAPTCHA_READY',
                    payload: {
                        captchaImage: captchaScreenshot.toString('base64')
                    }
                }));
            }

            // --- FLUJO PASO 2: Recibir la solución y completar el scraping ---
            else if (request.type === 'SOLVE_CAPTCHA' && page) {
                const { captchaSolution } = request.data;
                console.log(`Solución de CAPTCHA recibida: ${captchaSolution}`);
                
                await page.locator('#ctl00_MainContent_TxtCaptchaNumbers').type(captchaSolution);

                // ✅ PRIMERA CAPTURA DE PANTALLA: Justo antes de hacer clic.
                await page.screenshot({ path: 'debug-before-click.png' });
                console.log('Captura de depuración guardada: debug-before-click.png');

                await page.locator('#ctl00_MainContent_BtnBusqueda').click();

                const successSelector = '#ctl00_MainContent_PnlResultados';
                const errorSelector = '#ctl00_MainContent_pnlErrorCaptcha';

                await Promise.race([
                    page.waitForSelector(successSelector, { state: 'visible', timeout: 15000 }),
                    page.waitForSelector(errorSelector, { state: 'visible', timeout: 15000 }),
                ]);
                
                if (await page.locator(errorSelector).isVisible()) {
                    const errorText = await page.locator('#ctl00_MainContent_lblError').textContent();
                    throw new Error(errorText || 'El CAPTCHA es incorrecto.');
                }
                
                console.log('¡CAPTCHA correcto! Extrayendo datos...');
                await page.screenshot({ path: 'debug-after-click.png' });
                console.log('Captura de depuración guardada: debug-after-click.png');

                const getText = async (page: Page, selector: string) => (await page.locator(selector).first().textContent())?.trim() ?? '';
                const scrapedData = {
                    rfcEmisor: await getText(page, '#ctl00_MainContent_LblRfcEmisor'),
                    nombreEmisor: await getText(page, '#ctl00_MainContent_LblNombreEmisor'),
                    rfcReceptor: await getText(page, '#ctl00_MainContent_LblRfcReceptor'),
                    nombreReceptor: await getText(page, '#ctl00_MainContent_LblNombreReceptor'),
                    folioFiscal: await getText(page, '#ctl00_MainContent_LbllUuid'),
                    fechaExpedicion: await getText(page, '#ctl00_MainContent_LblFechaEmision'),
                    totalCfdi: await getText(page, '#ctl00_MainContent_LblMonto'),
                    efectoComprobante: await getText(page, '#ctl00_MainContent_LblEfectoComprobante'),
                    estadoCfdi: await getText(page, '#ctl00_MainContent_LblEstado'),
                    estatusCancelacion: await getText(page, '#ctl00_MainContent_LblEsCancelable'),
                };

                // ✅ SEGUNDA CAPTURA DE PANTALLA: Justo después de extraer los datos.
                await page.screenshot({ path: 'debug-results.png' });
                console.log('Captura de resultados guardada: debug-results.png');

                // Enviamos los datos finales al cliente
                ws.send(JSON.stringify({
                    type: 'SCRAPE_SUCCESS',
                    payload: scrapedData
                }));

                // Cerramos el navegador y la conexión
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
        // Nos aseguramos de que el navegador se cierre si el cliente se desconecta.
        if (browser) await browser.close();
    });
});

