# رفع ترجمة النخبة إلى GitHub وتشغيلها

## رفع المشروع

1. أنشئ مستودعًا جديدًا وفارغًا في GitHub.
2. فك ضغط ملف `arabic-elite-subtitles-v3.6.0.zip`.
3. ارفع محتويات المجلد نفسها إلى جذر المستودع، بحيث يظهر `package.json` و`render.yaml` مباشرة.
4. لا تنشئ ملف `.env` داخل GitHub ولا ترفع مفاتيح API. ملف `.gitignore` يمنعه تلقائيًا.

## تشغيله برابط HTTPS ثابت عبر Render

1. افتح Render واختر **New > Blueprint**.
2. اربط مستودع GitHub؛ سيقرأ Render ملف `render.yaml` تلقائيًا.
3. أدخل مفاتيح المصادر عندما يطلبها Render. يكفي مصدر واحد، وتزيد النتائج بإضافة بقية المصادر.
4. بعد نجاح النشر افتح `https://YOUR-SERVICE.onrender.com/configure` واضغط تثبيت.

المتغيرات السرية:

- `OPENSUBTITLES_API_KEY`
- `SUBDL_API_KEY`
- `SUBSOURCE_API_KEY`
- `ARABICSUBS_API_KEY`
- `WYZIE_API_KEY`

لا تضع أي مفتاح داخل ملفات JavaScript أو `render.yaml`.

## ملاحظة GitHub

GitHub Pages لا يشغّل خادم Node.js، وGitHub Actions مخصص للاختبارات وليس لاستضافة الإضافة بشكل دائم. لذلك يبقى الكود في GitHub ويعمل الخادم على Render أو خدمة Node.js مشابهة.
