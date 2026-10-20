# ترجمة النخبة 3.5.1

إضافة Stremio ذاتية الاستضافة تجمع حتى 25 ترجمة عربية بشرية، ترتب المطابق لاسم إصدار الفيديو أولاً، وتختبر ملفات الترجمة قبل العرض أو عند الاختيار. لا تولّد ترجمة بالذكاء الاصطناعي، ولا تعرض الإنجليزية على أنها عربية.

## المصادر

المصادر المجانية المدمجة التي لا تحتاج مفتاحًا:

- TheSubtitleDB
- Subf2m
- أرشيف Mora العربي
- SubKong
- MiraiAnime للأنمي، ويتضمن أعمال فرق عربية مثل 3ASQ عندما تكون مفهرسة
- AniKoto للأنمي
- Stremio OpenSubtitles v3

المصادر الاختيارية التي تحتاج مفتاحًا في Render:

- OpenSubtitles
- SubDL
- SubSource
- Wyzie
- ArabicSubs

فشل أي مصدر لا يعطل بقية المصادر. تظهر النتائج بأرقام `1، 2، 3...` فقط، وكل نتيجة يطابق اسمها إصدار الفيديو تظهر معها `💪👍`. لا يضمن المشروع وجود 25 ملفًا لكل عمل؛ يعرض حتى 25 ملفًا حقيقيًا متاحًا ولا يصنع نسخًا وهمية.

## الصيغ المدعومة

- مباشرة: `SRT` و`VTT` و`ASS` و`SSA`.
- مع تحويل تلقائي إلى SRT: `SMI/SAMI` و`SBV` و`TTML/DFXP` و`MicroDVD/MPL2 SUB`.
- أرشيفات: `ZIP` و`GZIP`، مع اختيار ملف الحلقة الصحيحة من حزمة الموسم.
- غير مدعوم: ترجمات الصور `PGS/SUP` و`VobSub SUB/IDX` لأنها صور وليست نصًا.

كل ملف يُفك، ويُصحح ترميزه إلى UTF-8، ويُفحص للتأكد من وجود توقيت ونص عربي. عند فشل رابط، يجرب الخادم بدائل من مصادر أخرى بدل إظهار خطأ Stremio.

## النشر على Render

1. ارفع محتويات المشروع إلى جذر مستودع GitHub؛ يجب أن يكون `package.json` و`render.yaml` في الجذر، والكود الحقيقي داخل `src/`.
2. Render سيعيد النشر تلقائيًا من فرع `main`.
3. في Render > Environment احتفظ بهذه القيم:

```env
RESULT_MODE=top20
MAX_RESULTS=25
MIN_CONFIDENCE=70
DOWNLOAD_FALLBACKS=6
VALIDATE_BEFORE_LISTING=true
DEEP_ANALYSIS_CANDIDATES=25
MAX_SEARCH_PAGES=4
COMPANION_WAIT_MS=0
ALLOW_MACHINE_TRANSLATED=false
```

4. أضف مفاتيح المصادر التي تملكها فقط: `OPENSUBTITLES_API_KEY` و`SUBDL_API_KEY` و`SUBSOURCE_API_KEY` و`WYZIE_API_KEY`. احذف `ARABICSUBS_API_KEY` إذا كان يعيد 401.
5. بعد ظهور `Live` افتح `https://YOUR-SERVICE.onrender.com/configure`، واحذف النسخة القديمة من Stremio ثم ثبّت النسخة الجديدة مرة واحدة.

## الاختبار

```powershell
npm test
node --env-file-if-exists=.env scripts/audit-live-sources.mjs
```

النسخة الحالية اجتازت 73 اختبارًا محليًا. فحص المصادر الحي شمل Spider-Man: No Way Home، وThe Last of Us S01E01، وCode Geass S01E01، مع تنزيل ملفات عربية حقيقية من عدة مصادر.

## ملاحظات

- خطة Render المجانية تنام عند الخمول؛ أول طلب قد يتأخر قرابة دقيقة، لكن هذا لا يغيّر عدد الترجمات.
- دفع خطة Render يحسن الاستجابة فقط، ولا يضيف ترجمات جديدة.
- لا ترفع ملف `.env` أو مفاتيح API إلى GitHub.
- الموقع 3ASQ منتدى وحلقات كاملة وروابط خارجية، وليس API ثابتًا لملفات الترجمة. لذلك تعتمد الإضافة على نسخ ترجمات فرق 3ASQ المفهرسة لدى TheSubtitleDB وSubSource وSubf2m وMiraiAnime بدل كشط المنتدى مباشرة.
