require('dotenv').config();
const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');

// 1. تعريف الإضافة في Stremio
const manifest = {
    id: 'org.arabic.elitesubs.v2',
    version: '2.0.0',
    name: '⭐ نخبة الترجمات العربية (Top 25)',
    description: 'أفضل 25 ترجمة عربية بشرية مع دعم محاكاة الأنمي (🎨 ASS) وتصحيح الرموز التلقائي وفحص التوقيت (✅)',
    resources: ['subtitles'],
    types: ['movie', 'series', 'anime'],
    idPrefixes: ['tt', 'kitsu'],
    catalogs: []
};

const builder = new addonBuilder(manifest);

// 2. استخراج معلومات النسخة والفريق من اسم ملف الفيديو للمطابقة الدقيقة
function extractReleaseInfo(filename = '') {
    const clean = filename.toLowerCase();
    const groups = [
        'subsplease', 'erai-raws', 'horriblesubs', 'judas', 'ember', 'asw', 'dkb',
        'psa', 'rarbg', 'yts', 'ntb', 'flux', 'cakes', 'mezzo'
    ];
    const sources = ['bluray', 'web-dl', 'webrip', 'hdrip', 'remux', 'bdrip', 'crunchyroll', 'amzn', 'nf'];
    const resolutions = ['2160p', '4k', '1080p', '720p'];

    return {
        matchedGroups: groups.filter(g => clean.includes(g)),
        matchedSources: sources.filter(s => clean.includes(s)),
        matchedRes: resolutions.filter(r => clean.includes(r)),
        cleanName: clean.replace(/[^a-z0-9]/g, '')
    };
}

// 3. دالة تنظيف الرموز العشوائية وتصحيح الترميز العربي (UTF-8 / Windows-1256)
function decodeAndCleanSubtitle(buffer, format) {
    let text = buffer.toString('utf8');

    // فحص إذا كان النص فيه رموز خربانة أو مافيه حروف عربية واضحة (بسبب ترميز Windows-1256)
    const arabicRegex = /[\u0600-\u06FF]/g;
    const arabicMatches = text.match(arabicRegex) || [];
    const hasReplacementChars = text.includes('');

    if (hasReplacementChars || arabicMatches.length < 30) {
        // تحويل الملف من ترميز العربي القديم Windows-1256 إلى UTF-8 العالمي
        const win1256Text = iconv.decode(buffer, 'win1256');
        const winArabicMatches = win1256Text.match(arabicRegex) || [];
        if (winArabicMatches.length > arabicMatches.length) {
            text = win1256Text;
        }
    }

    // تنظيف الرموز المخفية الخربانة
    text = text.replace(/^\uFEFF/, ''); // إزالة BOM الزائدة ثم إضافتها بشكل نظيف
    text = text.replace(/\r\n|\r|\n/g, '\r\n');

    if (format === 'SRT') {
        // في ملفات SRT العادية فقط: إزالة الرموز العشوائية المزعجة مثل &$&$$ مع الحفاظ على النص العربي
        text = text.replace(/[&$#@%~^]{3,}/g, '');
        // إزالة أكواد ASS إذا انحطت بالغلط داخل ملف SRT
        text = text.replace(/\{\\[^}]+\}/g, '');
    }
    // ملاحظة: في ملفات ASS و SSA لا نلمس أكواد { } أبداً لأنها مسؤولة عن محاكاة الأنمي والألوان والتحريك!

    // إضافة UTF-8 BOM في البداية عشان كل أجهزة التلفزيون والجوال تقرأ العربي فوراً بدون لخبطة
    return '\uFEFF' + text;
}

// 4. خوارزمية التقييم والترتيب الذكية (أفضل 25 ترجمة)
function scoreAndRankSubtitles(subtitles, extra = {}, baseUrl = '') {
    const videoFilename = extra.filename || '';
    const videoHash = extra.videoHash || '';
    const videoInfo = extractReleaseInfo(videoFilename);

    // استبعاد الترجمات الآلية
    const humanSubs = subtitles.filter(sub => {
        const release = (sub.releaseName || '').toLowerCase();
        return !release.includes('machine') && !release.includes('google') && !release.includes('ai_translated');
    });

    const scored = humanSubs.map(sub => {
        let score = 0;
        const release = (sub.releaseName || '').toLowerCase();
        const cleanRelease = release.replace(/[^a-z0-9]/g, '');
        const format = (sub.format || 'SRT').toUpperCase();

        // 1) تطابق بصمة الفيديو (Video Hash) = دقة توقيت 100%
        if (videoHash && sub.moviehash && videoHash === sub.moviehash) {
            score += 100;
        }

        // 2) تطابق كامل لاسم ملف الفيديو
        if (videoInfo.cleanName && cleanRelease && (cleanRelease.includes(videoInfo.cleanName) || videoInfo.cleanName.includes(cleanRelease))) {
            score += 60;
        }

        // 3) تطابق فريق الترجمة أو الرفع (مهم جداً للأنمي مثل SubsPlease / Erai-raws)
        let groupMatched = false;
        videoInfo.matchedGroups.forEach(group => {
            if (release.includes(group)) {
                score += 40;
                groupMatched = true;
            }
        });

        // 4) تطابق نوع النسخة (Web-DL / BluRay)
        let sourceMatched = false;
        videoInfo.matchedSources.forEach(src => {
            if (release.includes(src)) {
                score += 20;
                sourceMatched = true;
            }
        });

        // 5) أولوية لصيغ المحاكاة والتنسيق الملون ASS / SSA
        const isStyled = (format === 'ASS' || format === 'SSA');
        if (isStyled) {
            score += 25;
        }

        // 6) تقييم إضافي حسب التحميلات والموثوقية
        if (sub.downloads > 300) score += 10;
        if (sub.isTrusted) score += 10;

        // متى نعتبر الترجمة دقيقة ومتناسقة مع الوقت ونعطيها ✅؟
        const isHighAccuracy = (score >= 45) || groupMatched || (sourceMatched && isStyled) || (videoHash && sub.moviehash === videoHash);

        return {
            ...sub,
            format,
            isStyled,
            isHighAccuracy,
            score
        };
    });

    // ترتيب من الأعلى نقاطاً للأقل وأخذ أفضل 25
    scored.sort((a, b) => b.score - a.score);
    const top25 = scored.slice(0, 25);

    return top25.map((sub, index) => {
        const rank = index + 1;
        const accuracyBadge = sub.isHighAccuracy ? '✅ | ' : '';
        const formatBadge = sub.isStyled ? `🎨 ${sub.format}` : `${sub.format}`;

        // التنسيق المرتب: ترجمة رقم 1 | ✅ | 🎨 ASS | SubDL
        const label = `ترجمة رقم ${rank} | ${accuracyBadge}${formatBadge} | ${sub.source}`;

        // تمرير رابط الترجمة عبر السيرفر حقنا عشان يفك الضغط ويصلح الرموز العشوائية تلقائياً
        const encodedUrl = encodeURIComponent(sub.url);
        const proxyUrl = `${baseUrl}/sub.${sub.format.toLowerCase()}?url=${encodedUrl}&format=${sub.format}`;

        return {
            id: `${sub.source}_${rank}_${sub.id}`,
            url: proxyUrl,
            lang: label
        };
    });
}

// 5. جلب الترجمات من SubDL
async function fetchFromSubDL(imdbId, season, episode) {
    if (!process.env.SUBDL_API_KEY) return [];
    try {
        const params = {
            api_key: process.env.SUBDL_API_KEY,
            imdb_id: imdbId,
            languages: 'AR',
            subs_per_page: 30,
            type: (season && episode) ? 'tv' : 'movie'
        };
        if (season && episode) {
            params.season_number = season;
            params.episode_number = episode;
        }

        const res = await axios.get('https://api.subdl.com/api/v1/subtitles', { params, timeout: 7000 });
        if (!res.data || !res.data.subtitles) return [];

        return res.data.subtitles.map(sub => {
            const nameLower = (sub.name || sub.release_name || '').toLowerCase();
            let format = 'SRT';
            if (nameLower.includes('.ass')) format = 'ASS';
            else if (nameLower.includes('.ssa')) format = 'SSA';

            return {
                id: sub.sd_id || Math.random().toString(36).substring(7),
                releaseName: sub.release_name || sub.name || '',
                format: format,
                url: `https://dl.subdl.com${sub.url}`,
                source: 'SubDL',
                downloads: sub.download_count || 0,
                isTrusted: Boolean(sub.author)
            };
        });
    } catch (err) {
        console.error('SubDL Error:', err.message);
        return [];
    }
}

// 6. جلب الترجمات من OpenSubtitles (مع فحص بصمة الفيديو والـ FPS)
async function fetchFromOpenSubtitles(imdbId, season, episode, videoHash) {
    if (!process.env.OPENSUBTITLES_API_KEY) return [];
    try {
        const numericImdb = imdbId.replace('tt', '');
        const params = {
            imdb_id: numericImdb,
            languages: 'ar',
            ai_translated: 'exclude',
            machine_translated: 'exclude'
        };
        if (season && episode) {
            params.season_number = season;
            params.episode_number = episode;
        }
        if (videoHash) {
            params.moviehash = videoHash;
        }

        const res = await axios.get('https://api.opensubtitles.com/api/v1/subtitles', {
            params,
            headers: {
                'Api-Key': process.env.OPENSUBTITLES_API_KEY,
                'User-Agent': 'ArabicEliteSubs v2.0'
            },
            timeout: 7000
        });

        if (!res.data || !res.data.data) return [];

        return res.data.data.map(item => {
            const attr = item.attributes;
            const fileName = (attr.files?.[0]?.file_name || attr.release || '').toLowerCase();
            let format = 'SRT';
            if (fileName.endsWith('.ass')) format = 'ASS';
            else if (fileName.endsWith('.ssa')) format = 'SSA';

            return {
                id: item.id,
                releaseName: attr.release || fileName,
                format: format,
                url: attr.url,
                source: 'OpenSubtitles',
                downloads: attr.download_count || 0,
                moviehash: attr.moviehash_match ? videoHash : null,
                isTrusted: attr.from_trusted || false
            };
        });
    } catch (err) {
        console.error('OpenSubtitles Error:', err.message);
        return [];
    }
}

// 7. جلب الترجمات من Subsource
async function fetchFromSubsource(imdbId, season, episode) {
    if (!process.env.SUBSOURCE_API_KEY) return [];
    try {
        const res = await axios.post('https://api.subsource.net/api/getMovie', {
            imdb: imdbId,
            api_key: process.env.SUBSOURCE_API_KEY
        }, { timeout: 7000 });

        if (!res.data || !res.data.subs) return [];

        return res.data.subs
            .filter(s => s.lang?.toLowerCase() === 'arabic')
            .map(sub => {
                const rName = (sub.releaseName || '').toLowerCase();
                const format = rName.includes('.ass') ? 'ASS' : (rName.includes('.ssa') ? 'SSA' : 'SRT');
                return {
                    id: sub.subId,
                    releaseName: sub.releaseName || '',
                    format: format,
                    url: `https://api.subsource.net/api/downloadSub/${sub.subId}`,
                    source: 'Subsource',
                    downloads: 500,
                    isTrusted: true
                };
            });
    } catch (err) {
        console.error('Subsource Error:', err.message);
        return [];
    }
}

// 8. إعداد سيرفر Express + معالج فك الضغط وتصحيح الرموز
const app = express();
app.use(cors());

// نخزن رابط السيرفر ديناميكياً عشان يشتغل سواء على جهازك أو على Render
let SERVER_BASE_URL = process.env.PUBLIC_URL || '';

app.use((req, res, next) => {
    if (!SERVER_BASE_URL) {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        SERVER_BASE_URL = `${protocol}://${req.get('host')}`;
    }
    next();
});

// نقطة النهاية (Endpoint) اللي تنظف الترجمة وتفك الضغط وترسلها لـ Stremio جاهزة
app.get('/sub.:ext', async (req, res) => {
    const targetUrl = req.query.url;
    const requestedFormat = (req.query.format || 'SRT').toUpperCase();

    if (!targetUrl) return res.status(400).send('Missing subtitle URL');

    try {
        const response = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            timeout: 10000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        let rawBuffer = Buffer.from(response.data);
        let detectedFormat = requestedFormat;

        // فحص إذا كان الملف مضغوط بصيغة ZIP (يبدأ بـ PK)
        if (rawBuffer.length > 4 && rawBuffer[0] === 0x50 && rawBuffer[1] === 0x4B) {
            const zip = new AdmZip(rawBuffer);
            const zipEntries = zip.getEntries();

            // الأولوية في السحب: نبحث عن ملف ASS/SSA أولاً (للأنمي المنسق)، وإذا ما فيه نأخذ SRT
            let bestEntry = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.ass') || e.entryName.toLowerCase().endsWith('.ssa'));
            if (bestEntry) {
                detectedFormat = 'ASS';
            } else {
                bestEntry = zipEntries.find(e => e.entryName.toLowerCase().endsWith('.srt') || e.entryName.toLowerCase().endsWith('.vtt'));
                detectedFormat = 'SRT';
            }

            if (bestEntry) {
                rawBuffer = bestEntry.getData();
            }
        }

        // تنظيف الرموز العشوائية وتصحيح الترميز العربي إلى UTF-8
        const cleanSubtitleText = decodeAndCleanSubtitle(rawBuffer, detectedFormat);

        // إرسال الملف بالصيغة الصحيحة لـ Stremio
        const contentType = (detectedFormat === 'ASS' || detectedFormat === 'SSA')
            ? 'text/x-ssa; charset=utf-8'
            : 'application/x-subrip; charset=utf-8';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');
        return res.send(cleanSubtitleText);
    } catch (err) {
        console.error('Subtitle Proxy Error:', err.message);
        return res.status(500).send('Error processing subtitle');
    }
});

// 9. ربط معالج Stremio الأساسي
builder.defineSubtitlesHandler(async ({ type, id, extra }) => {
    try {
        const parts = id.split(':');
        const imdbId = parts[0];
        const season = parts[1] ? parseInt(parts[1], 10) : null;
        const episode = parts[2] ? parseInt(parts[2], 10) : null;

        const [subdlSubs, opensubSubs, subsourceSubs] = await Promise.all([
            fetchFromSubDL(imdbId, season, episode),
            fetchFromOpenSubtitles(imdbId, season, episode, extra?.videoHash),
            fetchFromSubsource(imdbId, season, episode)
        ]);

        const allSubtitles = [...subdlSubs, ...opensubSubs, ...subsourceSubs];
        const baseUrl = SERVER_BASE_URL || `http://127.0.0.1:${process.env.PORT || 7000}`;

        const finalSubtitles = scoreAndRankSubtitles(allSubtitles, extra, baseUrl);
        return { subtitles: finalSubtitles };
    } catch (err) {
        console.error('Handler Error:', err.message);
        return { subtitles: [] };
    }
});

app.use('/', getRouter(builder.getInterface()));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
    console.log(`✅ الإضافة شغالة بكامل قوتها! الرابط: http://127.0.0.1:${PORT}/manifest.json`);
});
