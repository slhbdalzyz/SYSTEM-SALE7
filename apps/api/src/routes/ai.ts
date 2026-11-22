import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AI_FIELDS, type AiKind, type AiStatus } from "@pos/shared";
import { HttpError, requirePerm } from "../auth";
import { askAi, readAiConfig } from "../ai";
import { tenantFeatures } from "../features";

const TZ = "Africa/Tripoli";
const KINDS = Object.keys(AI_FIELDS) as [AiKind, ...AiKind[]];
const STEP_NAME: Record<string, string> = { products: "الأصناف والكميات", customers: "العملاء ودفتر الديون", suppliers: "الموردين وأرصدتهم", cash: "الكاش الموجود اليوم" };

/** What the helper knows about the page, so it answers about this system and nothing it made up. */
const GUIDE = `أنت «مساعد Sale7»، تساعد صاحب محل ليبي ينقل شغله من الدفتر الورقي لنظام نقاط البيع Sale7، في صفحة «من الدفتر للنظام».
تكلّم باللهجة الليبية البسيطة، بجمل قصيرة وخطوات مرقمة لما يلزم. ما تستعملش مصطلحات تقنية. الفلوس بالدينار الليبي (د.ل) وفيها ثلاث خانات عشرية.

الصفحة فيها أربع خطوات، كل وحدة تنفتح بالضغط عليها:
1. «الأصناف والكميات»: اسم الصنف (لازم)، الباركود (يمسحه بالماسح أو يخليه فاضي ويتعمل تلقائي)، القسم، الوحدة (حبة، علبة، كيلو…)، سعر البيع، التكلفة، الكمية الموجودة. للصنف اللي يتباع بالحبة وبالصندوق: يكتب «صندوق» في «العبوة الكبيرة» وعدد الحبات في «فيها كم»، وسعر الصندوق لو يختلف (لو فاضي يتحسب سعر الحبة × العدد). علامة «بالوزن» للخضرة واللحم وأي حاجة تتباع بالكيلو.
2. «العملاء ودفتر الديون»: اسم العميل (لازم)، الهاتف، الدين القديم اللي عليه، وحد الدين المسموح.
3. «الموردين وأرصدتهم»: اسم المورد (لازم)، الهاتف، والمبلغ اللي عليك له.
4. «الكاش الموجود اليوم»: الفلوس اللي في الدرج والخزنة، والبطاقات والمصرف لو فيه.

في كل خطوة فيه طريقتين: «✍️ اكتب بيدك» (جدول، Enter ينقلك للخانة اللي بعدها، والسطر الجديد يتفتح وحده، واللي يكتبه يتحفظ في الجهاز لين يدخله)، أو «📄 من ملف Excel» (ينزّل القالب، يعبيه، ويرفعه). السطر الغلط يتعلّم عليه والباقي يدخل. وفيه أزرار المساعد في الجدول: «📋 الصق قائمة» يرتب أي قائمة ملصوقة في الجدول، «📷 صورة الدفتر» يقرا صفحة الدفتر، و«🔍 راجع قبل الإدخال» يدوّر على الأخطاء.
بعد ما يكمل الخطوات الأربعة: يدير جرد للتأكد، ويعتمد جهاز الكاشير من «الأجهزة»، ويقدر يخفي الصفحة من ⚙️ الإعدادات.
نصيحة دايماً مفيدة: أول أسبوع يخلي الدفتر جنبه ويقارن آخر النهار بين تقرير الوردية والدفتر.

جاوب بس على أسئلة الانتقال للنظام واستعماله. لو ما تعرفش حاجة عن النظام قول بصراحة إنك مش متأكد وانصحه يكلّم الدعم من «🛟 الدعم الفني»، وما تخترعش أزرار أو ميزات. لو السؤال برا الموضوع، رجّعه بلطف للخطوات.`;

const FIELD_HELP: Record<AiKind, string> = {
  products: `name: اسم الصنف كما هو. barcode: أرقام الباركود لو مكتوبة، وإلا فاضي. category: القسم لو واضح (مثلاً المشروبات، المعلبات، المنظفات) وإلا فاضي. unit: وحدة البيع (حبة، علبة، قنينة، كيس، كيلو، لتر، رغيف، باكو). price: سعر البيع للوحدة بالأرقام بس (مثلاً 2.500). cost: سعر الشراء لو مكتوب. qty: الكمية الموجودة بالوحدة. pack: اسم العبوة الكبيرة لو الصنف يتباع بيها كمان (صندوق، كرتونة، شد). packQty: كم وحدة في العبوة الكبيرة. packPrice: سعر العبوة الكبيرة لو مكتوب. weighted: "1" لو يتباع بالوزن (خضرة، فواكه، لحم، جبنة بالكيلو) وإلا فاضي.`,
  customers: `name: اسم العميل. phone: رقم الهاتف بالأرقام بس. balance: الدين اللي عليه بالأرقام بس (موجب). limit: حد الدين لو مكتوب وإلا فاضي.`,
  suppliers: `name: اسم المورد أو الشركة. phone: رقم الهاتف بالأرقام بس. balance: المبلغ اللي عليك له بالأرقام بس.`,
};

const rowsSchema = (kind: AiKind) => ({
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: Object.fromEntries(AI_FIELDS[kind].map((f) => [f, { type: "string" }])),
        required: [...AI_FIELDS[kind]],
        additionalProperties: false,
      },
    },
    note: { type: "string" },
  },
  required: ["rows", "note"],
  additionalProperties: false,
});

const EXTRACT_RULES = `قواعد:
- كل سطر في الجدول صنف/شخص واحد. ما تخترعش أسماء أو أرقام مش موجودة؛ أي خانة مش مذكورة خليها نص فاضي "".
- الأرقام بالأرقام الإنجليزية (0-9) والنقطة للكسور، بدون عملة أو كلمات. "دينار ونص" = 1.500، "ربع" = 0.250.
- لو نفس الاسم مكرر بنفس المعلومات، خليه مرة وحدة.
- في "note" اكتب جملة قصيرة باللهجة الليبية عن أي حاجة ما فهمتهاش أو شكّيت فيها، أو نص فاضي لو كل شي واضح.`;

async function status(app: FastifyInstance, tid: string): Promise<AiStatus & { cfg: Awaited<ReturnType<typeof readAiConfig>> }> {
  const cfg = await readAiConfig(app.db);
  const used = (await app.db.query(
    `SELECT COALESCE(requests, 0) AS n FROM ai_usage WHERE tenant_id = $1 AND day = (now() AT TIME ZONE '${TZ}')::date`, [tid],
  )).rows[0]?.n ?? 0;
  const f = await tenantFeatures(app.db, tid);
  // No key (or switched off on the platform, the demo, the offline edition): nothing to show the shop at all.
  const off = !cfg.apiKey || !cfg.enabled;
  const reason = off ? null
    : !f.ai_helper ? "المساعد الذكي مش في باقتك. تقدر تطلبه من «الاشتراك»."
      : used >= cfg.dailyLimit ? `خلصت محاولات المساعد لليوم (${cfg.dailyLimit}). ترجع بكرة.`
        : null;
  return { ready: !off && !reason, reason, usedToday: Number(used), dailyLimit: cfg.dailyLimit, cfg };
}

/** The helper on «من الدفتر للنظام»: answers questions, sorts pasted lists and notebook photos into the grid, and checks it. */
export async function aiRoutes(app: FastifyInstance) {
  const allowed = { preHandler: requirePerm("products", "customers", "purchasing") };

  app.get("/ai/status", allowed, async (req) => {
    const { cfg: _cfg, ...s } = await status(app, req.user.tid);
    return s;
  });

  /** Checks the shop may ask, asks, and counts it against today's cap. */
  async function ask(tid: string, a: Parameters<typeof askAi>[1]) {
    const s = await status(app, tid);
    if (!s.ready) throw new HttpError(403, s.reason ?? "المساعد الذكي مش مفعّل حالياً.");
    const r = await askAi(s.cfg, a);
    await app.db.query(
      `INSERT INTO ai_usage (tenant_id, day, requests, input_tokens, output_tokens) VALUES ($1, (now() AT TIME ZONE '${TZ}')::date, 1, $2, $3)
       ON CONFLICT (tenant_id, day) DO UPDATE SET requests = ai_usage.requests + 1, input_tokens = ai_usage.input_tokens + $2, output_tokens = ai_usage.output_tokens + $3`,
      [tid, r.inputTokens, r.outputTokens],
    );
    return { ...r, usedToday: s.usedToday + 1, dailyLimit: s.dailyLimit };
  }

  const parseRows = (kind: AiKind, text: string) => {
    let out: { rows: Record<string, string>[]; note: string };
    try {
      out = JSON.parse(text);
    } catch {
      throw new HttpError(502, "المساعد رجّع جواب مش مفهوم. جرّب مرة ثانية.");
    }
    const fields = AI_FIELDS[kind];
    const rows = (out.rows ?? []).slice(0, 500)
      .map((r) => Object.fromEntries(fields.map((f) => [f, String(r[f] ?? "").trim().slice(0, 120)])))
      .filter((r) => r.name);
    return { rows, note: String(out.note ?? "").slice(0, 400) };
  };

  // ── 1. Questions ────────────────────────────────────────────────────────────────
  app.post("/ai/chat", allowed, async (req) => {
    const b = z.object({
      step: z.string().max(20).optional(),
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().trim().min(1).max(2000) })).min(1).max(16),
    }).parse(req.body);
    if (b.messages[b.messages.length - 1].role !== "user") throw new HttpError(400, "آخر رسالة لازم تكون سؤال");
    // Roles must take turns; merge any two in a row so the conversation stays valid.
    const msgs: { role: "user" | "assistant"; content: string }[] = [];
    for (const m of b.messages) {
      const last = msgs[msgs.length - 1];
      if (last?.role === m.role) last.content += `\n${m.text}`;
      else msgs.push({ role: m.role, content: m.text });
    }
    if (msgs[0].role !== "user") msgs.shift();
    const where = b.step && STEP_NAME[b.step] ? `\n\nصاحب المحل فاتح توا خطوة «${STEP_NAME[b.step]}».` : "";
    const r = await ask(req.user.tid, { system: GUIDE + where, messages: msgs, effort: "low" });
    return { reply: r.text, usedToday: r.usedToday, dailyLimit: r.dailyLimit };
  });

  // ── 2. A pasted list into the grid ─────────────────────────────────────────────
  app.post("/ai/structure", allowed, async (req) => {
    const b = z.object({ kind: z.enum(KINDS), text: z.string().trim().min(2).max(20000) }).parse(req.body);
    const r = await ask(req.user.tid, {
      system: `${GUIDE}\n\nمهمتك توا: تحوّل قائمة ${STEP_NAME[b.kind]} اللي لصقها صاحب المحل (من الواتساب أو Excel أو كلام مكتوب) لجدول.\nالخانات: ${FIELD_HELP[b.kind]}\n${EXTRACT_RULES}`,
      messages: [{ role: "user", content: [{ type: "text", text: `<list>\n${b.text}\n</list>` }] }],
      schema: rowsSchema(b.kind),
      effort: "medium",
    });
    return { ...parseRows(b.kind, r.text), usedToday: r.usedToday, dailyLimit: r.dailyLimit };
  });

  // ── 3. A notebook page photo into the grid ─────────────────────────────────────
  app.post("/ai/photo", { ...allowed, bodyLimit: 6 * 1024 * 1024 }, async (req) => {
    const b = z.object({
      kind: z.enum(KINDS),
      mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
      data: z.string().min(100).max(5_500_000).regex(/^[A-Za-z0-9+/=]+$/),
    }).parse(req.body);
    const r = await ask(req.user.tid, {
      system: `${GUIDE}\n\nمهمتك توا: تقرا صورة صفحة من دفتر المحل (مكتوبة باليد غالباً، بالعربي) وتطلّع منها ${STEP_NAME[b.kind]} في جدول.\nالخانات: ${FIELD_HELP[b.kind]}\n${EXTRACT_RULES}\n- لو كلمة أو رقم مش مقروء، اكتب أقرب قراءة وقول عليه في "note".`,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } },
          { type: "text", text: "طلّع الجدول من الصورة هذي." },
        ],
      }],
      schema: rowsSchema(b.kind),
      effort: "medium",
    });
    return { ...parseRows(b.kind, r.text), usedToday: r.usedToday, dailyLimit: r.dailyLimit };
  });

  // ── 4. Checking the grid before it goes in ─────────────────────────────────────
  app.post("/ai/check", allowed, async (req) => {
    const b = z.object({
      kind: z.enum(KINDS),
      rows: z.array(z.record(z.string(), z.string().max(200))).min(1).max(500),
    }).parse(req.body);
    const fields = AI_FIELDS[b.kind];
    const table = b.rows.map((r, i) => `${i + 1}\t${fields.map((f) => r[f] ?? "").join("\t")}`).join("\n");
    const r = await ask(req.user.tid, {
      system: `${GUIDE}\n\nمهمتك توا: تراجع جدول ${STEP_NAME[b.kind]} قبل ما يدخل للنظام، وتطلّع الأخطاء المحتملة بس: سعر صفر أو فاضي، سعر البيع أقل من التكلفة، سعر غريب جداً مقارنة بأصناف شبهه، اسم مكرر أو شبه مكرر، كمية غريبة، باركود ناقص أرقام، هاتف مش ليبي (الليبي يبدا بـ 09 وفيه 10 أرقام)، دين كبير بشكل غريب، صنف بالوزن ووحدته مش كيلو.\nالخانات: ${FIELD_HELP[b.kind]}\nرجّع قائمة "issues": كل وحدة فيها "row" (رقم السطر) و"message" (جملة قصيرة باللهجة الليبية فيها المشكلة والتصليح المقترح). لو ما فيش مشاكل رجّع قائمة فاضية. ما تذكرش الخانات الفاضية الاختيارية كمشكلة.`,
      messages: [{ role: "user", content: [{ type: "text", text: `الأعمدة: #\t${fields.join("\t")}\n${table}` }] }],
      schema: {
        type: "object",
        properties: { issues: { type: "array", items: { type: "object", properties: { row: { type: "integer" }, message: { type: "string" } }, required: ["row", "message"], additionalProperties: false } } },
        required: ["issues"],
        additionalProperties: false,
      },
      effort: "low",
    });
    let issues: { row: number; message: string }[];
    try {
      issues = (JSON.parse(r.text).issues ?? []) as { row: number; message: string }[];
    } catch {
      throw new HttpError(502, "المساعد رجّع جواب مش مفهوم. جرّب مرة ثانية.");
    }
    return {
      issues: issues.filter((x) => Number.isInteger(x.row) && x.row >= 1 && x.row <= b.rows.length).slice(0, 100).map((x) => ({ row: x.row, message: String(x.message).slice(0, 300) })),
      usedToday: r.usedToday, dailyLimit: r.dailyLimit,
    };
  });
}
