const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const app = express();

// Твой ключ берется из настроек Vercel (Environment Variables)
const RD_API_KEY = process.env.RD_KEY;

const manifest = {
    id: 'org.stremio.rd.ru_mega',
    name: 'RD Russian Mega Scraper',
    version: '2.1.0',
    description: 'Rutor, NNM-Club, Fast-Torrent + Real-Debrid',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt']
};

// Заголовки, чтобы сайты не блокировали нас
const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36'
};

// --- ПОИСКОВЫЕ ДВИЖКИ ---

async function searchRutor(query) {
    try {
        const url = `https://rutor.info/search/0/0/100/0/${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { headers, timeout: 3500 });
        const $ = cheerio.load(data);
        const results = [];
        $('tr.gai, tr.tum').each((i, el) => {
            const title = $(el).find('td:nth-child(2) a:nth-child(3)').text();
            const magnet = $(el).find('td:nth-child(2) a:nth-child(2)').attr('href');
            if (magnet) results.push({ title: `[Rutor] ${title}`, magnet });
        });
        return results;
    } catch (e) { return []; }
}

async function searchNNM(query) {
    try {
        const url = `https://nnmclub.to/forum/tracker.php?nm=${encodeURIComponent(query)}`;
        const { data } = await axios.get(url, { headers, timeout: 3500 });
        const $ = cheerio.load(data);
        const results = [];
        $('tr.prow1, tr.prow2').each((i, el) => {
            const title = $(el).find('a.genmed').text();
            const magnet = $(el).find('a[href^="magnet:"]').attr('href');
            if (magnet) results.push({ title: `[NNM] ${title}`, magnet });
        });
        return results;
    } catch (e) { return []; }
}

async function searchFastTorrent(query) {
    try {
        const url = `https://www.fast-torrent.ru/search/${encodeURIComponent(query)}/1.html`;
        const { data } = await axios.get(url, { headers, timeout: 3500 });
        const $ = cheerio.load(data);
        const results = [];
        $('.num_list .item').each((i, el) => {
            const title = $(el).find('.film-name a').text();
            const magnet = $(el).find('a.download-magnet').attr('href') || $(el).find('a[href^="magnet:"]').attr('href');
            if (magnet) results.push({ title: `[FastTorrent] ${title}`, magnet });
        });
        return results;
    } catch (e) { return []; }
}

// --- ОСНОВНАЯ ЛОГИКА ---

app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(manifest);
});

app.get('/stream/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { type, id } = req.params;

    try {
        // 1. Получаем название фильма из Stremio
        const meta = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`).then(r => r.data);
        const title = meta.meta.name;
        const year = meta.meta.releaseInfo || meta.meta.year || '';
        const query = `${title} ${year}`.trim();

        // 2. Ищем на всех сайтах параллельно
        const [rutor, nnm, fast] = await Promise.all([
            searchRutor(query),
            searchNNM(query),
            searchFastTorrent(title) // Для фаст-торрента лучше только название
        ]);

        const allTorrents = [...rutor, ...nnm, ...fast];

        // 3. Превращаем торренты в стримы для Stremio
        const streams = allTorrents.slice(0, 20).map(t => {
            const hashMatch = t.magnet.match(/btih:([a-zA-Z0-9]+)/);
            if (!hashMatch) return null;

            // Определяем качество для иконки
            let quality = '📺 SD';
            if (t.title.includes('2160') || t.title.toLowerCase().includes('4k')) quality = '💎 4K';
            else if (t.title.includes('1080')) quality = '✅ 1080p';
            else if (t.title.includes('720')) quality = '720p';

            return {
                name: quality,
                title: t.title,
                // Ссылка ведет на наш обработчик play
                url: `https://${req.get('host')}/play/${hashMatch[1]}`
            };
        }).filter(s => s !== null);

        res.json({ streams });
    } catch (e) {
        res.json({ streams: [] });
    }
});

// --- ОБРАБОТЧИК PLAY (ВЗАИМОДЕЙСТВИЕ С REAL-DEBRID) ---

app.get('/play/:hash', async (req, res) => {
    const { hash } = req.params;
    const magnet = `magnet:?xt=urn:btih:${hash}`;

    try {
        // 1. Добавляем в RD
        const add = await axios.post('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', 
            new URLSearchParams({ magnet }),
            { headers: { 'Authorization': `Bearer ${RD_API_KEY}` } }
        ).then(r => r.data);

        // 2. Выбираем все файлы
        await axios.post(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${add.id}`, 
            new URLSearchParams({ files: 'all' }),
            { headers: { 'Authorization': `Bearer ${RD_API_KEY}` } }
        );

        // 3. Получаем прямую ссылку
        const info = await axios.get(`https://api.real-debrid.com/rest/1.0/torrents/info/${add.id}`,
            { headers: { 'Authorization': `Bearer ${RD_API_KEY}` } }
        ).then(r => r.data);

        if (info.links && info.links.length > 0) {
            const unrestrict = await axios.post('https://api.real-debrid.com/rest/1.0/unrestrict/link',
                new URLSearchParams({ link: info.links[0] }),
                { headers: { 'Authorization': `Bearer ${RD_API_KEY}` } }
            ).then(r => r.data);

            // Перенаправляем плеер Stremio прямо на видеофайл
            res.redirect(unrestrict.download);
        } else {
            res.status(404).send("Торрент еще не готов. Подождите пару минут, пока RD скачает его в облако.");
        }
    } catch (e) {
        res.status(500).send("Ошибка Real-Debrid: " + e.message);
    }
});

module.exports = app;
