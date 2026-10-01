/* Field validation, shared by every write path.
 *
 * Rules live here (not only in the browser) because the API is the security
 * boundary. Each entity is described declaratively, which lets the admin UI ask
 * the server for the same rules (GET /api/cms/schema) instead of duplicating them.
 *
 * Content is stored as PLAIN TEXT and rendered as plain text: no HTML, no
 * markdown, no raw markup can ever come back out of the public endpoints.
 */

import { badRequest } from "./http.mjs";
import { config } from "./config.mjs";

const BENGALI_DIGITS = "০১২৩৪৫৬৭৮৯";

/** Collapses CRLF, strips invisible control chars, trims, clamps blank runs. */
export const text = (value) => {
  if (value === undefined || value === null) return "";
  return String(value)
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200d\ufeff]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
};

const dateValue = (value) => {
  const raw = text(value);
  if (!raw) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) throw badRequest("তারিখের ফরম্যাট YYYY-MM-DD হতে হবে।");
  const [, y, m, d] = match.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) throw badRequest("তারিখটি সঠিক নয়।");
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw badRequest("তারিখটি সঠিক নয়।");
  if (y < 1900 || y > 2200) throw badRequest("তারিখের সাল অযৌক্তিক।");
  return raw;
};

const timeValue = (value) => {
  const raw = text(value);
  if (!raw) return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw badRequest("সময়ের ফরম্যাট HH:MM (24 ঘণ্টা) হতে হবে।");
  return `${raw}:00`;
};

/** Optional media reference: must be a key this server actually generated. */
const mediaValue = (value) => {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "object") throw badRequest("সংযুক্ত ফাইলের তথ্য সঠিক নয়।");
  const path = text(value.path);
  if (!/^(images|docs)\/\d{4}-\d{2}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/.test(path)) {
    throw badRequest("ফাইলের পথ গ্রহণযোগ্য নয়।");
  }
  const name = text(value.name).slice(0, 120);
  const mime = text(value.mime).slice(0, 100);
  const bytes = Number.isInteger(value.bytes) && value.bytes > 0 && value.bytes <= config.maxImageBytes ? value.bytes : null;
  return { path, name: name || null, mime: mime || null, bytes };
};

export const SCHEMA = {
  notice: {
    label: "নোটিশ",
    fields: {
      title: { label: "শিরোনাম", type: "text", required: true, min: 4, max: 220, hint: "সংক্ষিপ্ত স্পষ্ট শিরোনাম লিখুন।" },
      body: { label: "বিবরণ", type: "textarea", required: true, min: 2, max: 8000, hint: "প্রতিটি নতুন লাইন আলাদা অনুচ্ছেদ হিসেবে দেখানো হবে।" },
      audience: { label: "শ্রেণি / উদ্দেশ্য", type: "text", max: 80, placeholder: "যেমন: সকল শ্রেণি" },
      notice_type: {
        label: "ধরন",
        type: "select",
        values: ["general", "exam", "result", "admission", "event", "emergency"],
        labels: ["সাধারণ", "পরীক্ষা", "ফলাফল", "ভর্তি", "অনুষ্ঠান", "জরুরি"],
        default: "general",
      },
      importance: {
        label: "গুরুত্ব",
        type: "select",
        values: ["normal", "urgent"],
        labels: ["সাধারণ", "জরুরি (সবার উপরে দেখানো হবে)"],
        default: "normal",
      },
      published_at: { label: "প্রকাশের তারিখ", type: "date", required: true },
      status: { label: "অবস্থা", type: "status", values: ["draft", "published", "unpublished"] },
      file: { label: "সংযুক্তি (PDF/ছবি)", type: "media" },
    },
  },
  exam: {
    label: "পরীক্ষার রুটিন",
    fields: {
      exam_name: { label: "পরীক্ষার নাম", type: "text", required: true, min: 2, max: 160, placeholder: "যেমন: অর্ধ-বার্ষিক পরীক্ষা ২০২৬" },
      class_name: { label: "শ্রেণি", type: "text", required: true, max: 40, placeholder: "যেমন: নবম" },
      subject: { label: "বিষয়", type: "text", required: true, max: 120, placeholder: "যেমন: গণিত" },
      exam_date: { label: "তারিখ", type: "date", required: true },
      start_time: { label: "সময়", type: "time", hint: "২৪ ঘণ্টার ফরম্যাট, যেমন 10:00" },
      room: { label: "কক্ষ / ভেন্যু", type: "text", max: 80, placeholder: "যেমন: ভবনের ২য় তলা" },
      notes: { label: "অতিরিক্ত নির্দেশনা", type: "textarea", max: 1000 },
      file: { label: "রুটিনের নথি (PDF)", type: "media" },
      published_at: { label: "প্রকাশের তারিখ", type: "date", required: true },
      status: { label: "অবস্থা", type: "status", values: ["draft", "published", "unpublished"] },
      sort_order: { label: "ক্রম", type: "int", default: 0, min: 0, max: 9999 },
    },
  },
  routine: {
    label: "রুটিন",
    fields: {
      title: { label: "শিরোনাম", type: "text", required: true, min: 3, max: 200 },
      routine_type: {
        label: "ধরন",
        type: "text",
        required: true,
        max: 60,
        suggestions: ["শ্রেণি রুটিন", "সাপ্তাহিক কার্যক্রম", "ঈদ/ছুটির সময়সূচি", "অনুষ্ঠান", "পরীক্ষা কেন্দ্র"],
        hint: "যেকোনো ধরনের নাম লিখতে পারবেন — নতুন ধরন যোগ করতে কোড পরিবর্তন লাগবে না।",
      },
      class_name: { label: "শ্রেণি (প্রযোজ্য হলে)", type: "text", max: 40 },
      event_date: { label: "তারিখ", type: "date" },
      start_time: { label: "শুরু", type: "time" },
      end_time: { label: "শেষ", type: "time" },
      description: { label: "বিবরণ", type: "textarea", max: 4000 },
      file: { label: "সংযুক্তি (PDF/ছবি)", type: "media" },
      published_at: { label: "প্রকাশের তারিখ", type: "date", required: true },
      status: { label: "অবস্থা", type: "status", values: ["draft", "published", "unpublished"] },
    },
  },
  album: {
    label: "অ্যালবাম",
    fields: {
      title: { label: "অ্যালবামের নাম", type: "text", required: true, min: 2, max: 160 },
      description: { label: "বিবরণ", type: "textarea", max: 1000 },
      category: {
        label: "ক্যাটাগরি (গ্যালারির ফিল্টার)",
        type: "select",
        values: ["campus", "sports", "programs", "tours", "tree", "activities"],
        labels: ["বিদ্যালয় ক্যাম্পাস", "খেলাধুলা ও মাঠ", "বিদ্যালয়ের অনুষ্ঠান", "শিক্ষা সফর", "বৃক্ষরোপণ", "সহশিক্ষা ও কার্যক্রম"],
        default: "campus",
        hint: "বিদ্যমান গ্যালারি ফিল্টারের সাথে মিলিয়ে ছবি দেখানো হবে।",
      },
      album_date: { label: "আয়োজনের তারিখ", type: "date" },
      cover_photo_id: { label: "কভার ছবি", type: "uuid" },
      published_at: { label: "প্রকাশের তারিখ", type: "date", required: true },
      status: { label: "অবস্থা", type: "status", values: ["draft", "published", "unpublished"] },
    },
  },
  photo: {
    label: "ছবি",
    fields: {
      alt_text: { label: "ছবির বর্ণনা (alt)", type: "text", max: 300, hint: "যারা পর্দা-পাঠক ব্যবহার করেন তাদের জন্য; ছবিতে যা দেখা যাচ্ছে তা লিখুন।" },
      caption: { label: "ক্যাপশন", type: "text", max: 300 },
      sort_order: { label: "ক্রম", type: "int", default: 0, min: 0, max: 9999 },
    },
  },
  account: {
    label: "অ্যাকাউন্ট",
    fields: {
      email: { label: "ইমেইল", type: "email", required: true, max: 160 },
      full_name: { label: "নাম", type: "text", required: true, min: 2, max: 80 },
      role: {
        label: "ভূমিকা",
        type: "select",
        values: ["admin", "staff"],
        labels: ["অ্যাডমিন (অ্যাকাউন্টও চালাতে পারবেন)", "স্টাফ (শুধু কনটেন্ট)"],
        default: "staff",
      },
      password: { label: "পাসওয়ার্ড", type: "password", hint: "অন্তত ১০ অক্ষর। অন্য কোথাও ব্যবহার করা হয়নি এমন একটি দিন।" },
    },
  },
};

const FIELD_KEY = /^[a-z_]{2,20}$/;

const checkPassword = (password) => {
  if (typeof password !== "string" || password.length < 10) {
    throw badRequest("পাসওয়ার্ড অন্তত ১০ অক্ষরের হতে হবে।", { password: "পাসওয়ার্ড অন্তত ১০ অক্ষরের হতে হবে।" });
  }
  if (password.length > 200) throw badRequest("পাসওয়ার্ড অনেক লম্বা।", { password: "অনেক লম্বা।" });
  const weak = ["password", "123456", "school", "admin", "rahs", "iloveyou", "qwerty"];
  if (weak.some((w) => password.toLowerCase().includes(w))) {
    throw badRequest("পাসওয়ার্ডটি অনুমান করা সহজ — অন্য কিছু ব্যবহার করুন।", { password: "অনুমান করা সহজ।" });
  }
};

/**
 * Validates a write payload for `entity`.
 * `partial: true` (PATCH) only checks keys that are actually present;
 * `partial: false` (POST) also fills defaults and requires mandatory fields.
 * Returns the clean object to persist.
 */
export function validate(entity, input = {}, { partial = false } = {}) {
  const spec = SCHEMA[entity];
  if (!spec) throw badRequest(`অজানা কনটেন্ট টাইপ: ${entity}`);
  const out = {};
  const errors = {};

  for (const key of Object.keys(input)) {
    if (!FIELD_KEY.test(key) || !(key in spec.fields)) {
      errors[key] = "এই ঘরটি গ্রহণযোগ্য নয়।";
    }
  }
  if (Object.keys(errors).length) throw badRequest("অনুরোধে অজানা ঘর রয়েছে।", errors);

  for (const [key, rule] of Object.entries(spec.fields)) {
    const present = Object.prototype.hasOwnProperty.call(input, key);
    if (!present && partial) continue;
    const raw = present ? input[key] : undefined;

    if (rule.type === "media") {
      const value = mediaValue(raw);
      if (value) {
        out[`${key}_path`] = value.path;
        if (key === "file") {
          out.file_name = value.name;
          out.file_mime = value.mime;
          out.file_bytes = value.bytes;
        }
      } else {
        out[`${key}_path`] = null;
        if (key === "file") {
          out.file_name = null;
          out.file_mime = null;
          out.file_bytes = null;
        }
      }
      continue;
    }

    if (rule.type === "int") {
      if (raw === undefined || raw === null || raw === "") {
        if (!present && rule.default !== undefined) out[key] = rule.default;
        continue;
      }
      const value = Number(raw);
      if (!Number.isInteger(value) || value < (rule.min ?? 0) || value > (rule.max ?? 1e9)) {
        errors[key] = `${rule.label}: পূর্ণসংখ্যা ${rule.min ?? 0}–${rule.max ?? ""}।`;
        continue;
      }
      out[key] = value;
      continue;
    }

    if (rule.type === "status") {
      const value = text(raw) || (present ? "" : rule.default) || "draft";
      if (!rule.values.includes(value)) {
        errors[key] = `${rule.label}: ${rule.values.join(", ")} এর একটি হতে হবে।`;
        continue;
      }
      out[key] = value;
      continue;
    }

    if (rule.type === "date") {
      let value = null;
      try {
        value = dateValue(raw);
      } catch (error) {
        errors[key] = error.message;
        continue;
      }
      if (!value) {
        if (rule.required) errors[key] = `${rule.label} আবশ্যক।`;
        else out[key] = null;
        continue;
      }
      out[key] = value;
      continue;
    }

    if (rule.type === "time") {
      try {
        const value = timeValue(raw);
        if (value) out[key] = value;
        else if (rule.required) errors[key] = `${rule.label} আবশ্যক।`;
        else out[key] = null;
      } catch (error) {
        errors[key] = error.message;
      }
      continue;
    }

    if (rule.type === "uuid") {
      const value = text(raw);
      if (!value) {
        out[key] = null;
        continue;
      }
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        errors[key] = `${rule.label}: সঠিক আইডি প্রয়োজন।`;
        continue;
      }
      out[key] = value.toLowerCase();
      continue;
    }

    if (rule.type === "email") {
      const value = text(raw).toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) errors[key] = `${rule.label}: সঠিক ইমেইল দিন।`;
      else out[key] = value.slice(0, rule.max);
      continue;
    }

    if (rule.type === "password") {
      try {
        checkPassword(raw);
        out[key] = raw;
      } catch (error) {
        if (error.status === 400 && error.extra) Object.assign(errors, error.extra);
        else errors[key] = error.message;
      }
      continue;
    }

    if (rule.type === "select") {
      const value = text(raw) || (partial ? "" : rule.default) || "";
      if (!value) {
        if (rule.required) errors[key] = `${rule.label} নির্বাচন করুন।`;
        else if (rule.default !== undefined) out[key] = rule.default;
        continue;
      }
      if (!rule.values.includes(value)) {
        errors[key] = `${rule.label}: তালিকা থেকে একটি বেছে নিন।`;
        continue;
      }
      out[key] = value;
      continue;
    }

    // text / textarea
    const value = rule.type === "textarea" ? text(raw) : text(raw).replace(/\s+/g, " ");
    if (!value) {
      if (rule.required) errors[key] = `${rule.label} খালি রাখা যাবে না।`;
      else out[key] = null;
      continue;
    }
    if (rule.min && value.length < rule.min) {
      errors[key] = `${rule.label}: অন্তত ${rule.min} অক্ষর লিখুন।`;
      continue;
    }
    if (rule.max && value.length > rule.max) {
      errors[key] = `${rule.label}: সর্বোচ্চ ${rule.max} অক্ষর।`;
      continue;
    }
    out[key] = value;
  }

  // Publish rules: anything marked published must be complete and dated.
  if (out.status === "published") {
    for (const [key, rule] of Object.entries(spec.fields)) {
      if (rule.required && !out[key] && !partial) errors[key] = `${rule.label} পূরণ করুন।`;
    }
    if (!out.published_at && !(partial && Object.prototype.hasOwnProperty.call(input, "published_at"))) {
      errors.published_at = "প্রকাশের আগে তারিখ দিতে হবে।";
    }
  }

  if (out.published_at) out.published_at = dateValue(out.published_at);
  if (Object.keys(errors).length) throw badRequest("তথ্যে কিছু সমস্যা আছে।", errors);
  return out;
}

/** Bengali-numeral friendly date label used by the public pages and the admin list. */
export const toBengaliDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
  const months = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"];
  const digits = (value) => String(value).replace(/\d/g, (c) => BENGALI_DIGITS[Number(c)]);
  return `${digits(d)} ${months[(m || 1) - 1]} ${digits(y)}`;
};

export { checkPassword };

export { moduleOnly as default } from "./guard.mjs";
