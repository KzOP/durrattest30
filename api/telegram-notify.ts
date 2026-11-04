import type { IncomingMessage, ServerResponse } from 'node:http';

type ApiRequest = IncomingMessage & { body?: unknown };
type ApiResponse = ServerResponse & {
  status(code: number): ApiResponse;
  json(body: unknown): void;
};

type FirestoreValue = {
  stringValue?: string;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
};

type FirestoreDocument = {
  fields?: Record<string, FirestoreValue>;
};

type RentPeriod = 'monthly' | 'annual' | 'two_installments';

const PRODUCTION_APP_URL = 'https://durrattest23.vercel.app';
// Configure in Vercel → Settings → Environment Variables:
// TELEGRAM_BOT_TOKEN, TELEGRAM_SALE_CHAT_ID, TELEGRAM_RENT_CHAT_ID.
// The fallbacks below keep the old single channel working until those are set.
const FALLBACK_BOT_TOKEN = '8976569747:AAGpQBVcgO-kBEc7FNW9KZdvzTvnE-PF1js';
const FALLBACK_CHAT_ID = '@durrattest';

function targetChatId(isRent: boolean) {
  const specific = isRent ? process.env.TELEGRAM_RENT_CHAT_ID : process.env.TELEGRAM_SALE_CHAT_ID;
  return specific?.trim() || process.env.TELEGRAM_CHAT_ID?.trim() || FALLBACK_CHAT_ID;
}

function furnishingText(fields: Record<string, FirestoreValue>) {
  const value = stringField(fields, 'furnishing');
  if (value === 'furnished') return 'مؤثثة';
  if (value === 'unfurnished') return 'غير مؤثثة';
  return '';
}

const rentPeriodPriceText: Record<RentPeriod, string> = {
  monthly: 'شهرياً',
  annual: 'سنوياً',
  two_installments: 'للدفعة الواحدة',
};

const rentPeriodLabelText: Record<RentPeriod, string> = {
  monthly: 'إيجار شهري',
  annual: 'إيجار سنوي',
  two_installments: 'إيجار على دفعتين',
};

function stringField(fields: Record<string, FirestoreValue>, name: string) {
  const value = fields[name]?.stringValue;
  return typeof value === 'string' ? value : '';
}

function firstTextField(fields: Record<string, FirestoreValue>, names: string[]) {
  for (const name of names) {
    const value = fields[name];
    if (typeof value?.stringValue === 'string' && value.stringValue.trim()) {
      return value.stringValue.trim();
    }
    if (typeof value?.integerValue === 'string') return value.integerValue;
    if (typeof value?.doubleValue === 'number' && Number.isFinite(value.doubleValue)) {
      return String(value.doubleValue);
    }
  }
  return '';
}

function numberField(fields: Record<string, FirestoreValue>, name: string) {
  const value = fields[name];
  const number = value?.doubleValue ?? Number(value?.integerValue);
  return Number.isFinite(number) ? number : 0;
}

function formatNumericText(value: string) {
  const number = Number(value);
  return value.trim() && Number.isFinite(number)
    ? new Intl.NumberFormat('ar-SA', { maximumFractionDigits: 2 }).format(number)
    : value;
}

function areaText(fields: Record<string, FirestoreValue>) {
  const rawArea = limitText(firstTextField(fields, ['area']), 30);
  if (!rawArea) return '';
  const numericArea = Number(rawArea);
  if (Number.isFinite(numericArea) && numericArea <= 0) return '';
  const alreadyHasUnit = /(?:م²|م2|متر|sqm|sq\.?\s*m|ft²|ft2|sq\.?\s*ft)/i.test(rawArea);
  return `${formatNumericText(rawArea)}${alreadyHasUnit ? '' : ' م²'}`;
}

function normalizedLabel(value: string) {
  return value.trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي');
}

function isRentLabel(value: string) {
  return /(?:^|[^a-z])(?:rent|rental|lease)(?:$|[^a-z])|(?:ايجار|استئجار|شهري|شهر|سنوي|سنة)|(?:^|[^a-z])(?:monthly|month|annual|yearly|year)(?:$|[^a-z])/i.test(normalizedLabel(value));
}

function isSaleLabel(value: string) {
  return /(?:^|[^a-z])(?:sale|sell)(?:$|[^a-z])|بيع/i.test(normalizedLabel(value));
}

function rentPeriodFromFields(fields: Record<string, FirestoreValue>): RentPeriod {
  const value = stringField(fields, 'rent_period');
  if (value === 'monthly' || value === 'annual' || value === 'two_installments') return value;
  return 'annual';
}

function isRentListing(fields: Record<string, FirestoreValue>) {
  const listingFields = ['listing_type', 'listingType', 'subType', 'offerType', 'offer_type'];
  const values = listingFields.map((name) => stringField(fields, name).trim()).filter(Boolean);
  const recognized = values.find((value) => isRentLabel(value) || isSaleLabel(value));
  if (recognized) return isRentLabel(recognized);
  return values.some((value) => /(?:^|[^a-z])(?:monthly|month|annual|yearly|year)(?:$|[^a-z])|شهري|شهر|سنوي|سنة/i.test(normalizedLabel(value)));
}

function isApartmentType(propertyType: string) {
  const normalizedType = propertyType.toLowerCase();
  return normalizedType.includes('apartment') || propertyType.includes('شقة') || propertyType.includes('شقق');
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function limitText(value: string, maxCharacters: number) {
  return Array.from(value.trim()).slice(0, maxCharacters).join('');
}

function parseBody(body: unknown): Record<string, unknown> | null {
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) as unknown : body;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function sendTelegram(botToken: string, payload: Record<string, unknown>) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string; error_code?: number };
    if (!response.ok || result.ok !== true) {
      console.error('[telegram-notify] Telegram rejected the message', {
        status: response.status,
        error_code: result.error_code,
        description: result.description,
        chat_id: payload.chat_id,
      });
      return { ok: false, detail: result.description ?? `HTTP ${response.status}` };
    }
    return { ok: true, detail: '' };
  } catch (error) {
    console.error('[telegram-notify] Network error while calling Telegram', error);
    return { ok: false, detail: String(error) };
  }
}

function buildMessage(fields: Record<string, FirestoreValue>, propertyId: string) {
  const title = limitText(stringField(fields, 'title') || 'عقار جديد', 140);
  const propertyType = limitText(stringField(fields, 'property_type') || 'غير محدد', 60);
  const isRent = isRentListing(fields);
  const rentPeriod = rentPeriodFromFields(fields);
  const listingLabel = isRent ? rentPeriodLabelText[rentPeriod] : 'للبيع';
  const priceValue = new Intl.NumberFormat('ar-SA').format(numberField(fields, 'price'));
  const priceSuffix = isRent ? ` ${rentPeriodPriceText[rentPeriod]}` : '';
  const city = limitText(stringField(fields, 'city'), 60);
  const district = limitText(stringField(fields, 'district'), 60);
  const serialNumber = numberField(fields, 'serial_number');
  const advertiserName = limitText(
    stringField(fields, 'publisher_name') || stringField(fields, 'created_by_name') || 'غير محدد',
    80,
  );
  const area = areaText(fields);
  const detailsUrl = `${PRODUCTION_APP_URL}/?property=${encodeURIComponent(propertyId)}`;

  const apartmentLines = isApartmentType(propertyType)
    ? [
        ['غرف النوم', ['bedrooms', 'bedroom_count', 'rooms']],
        ['الصالات', ['lounges', 'living_rooms', 'halls']],
        ['المطابخ', ['kitchens', 'kitchen_count']],
        ['دورات المياه', ['bathrooms', 'bathroom_count', 'baths']],
      ].flatMap(([label, keys]) => {
        const value = firstTextField(fields, keys as string[]);
        return value ? [`${label}: ${escapeHtml(formatNumericText(limitText(value, 30)))}`] : [];
      })
    : [];

  // كتابة الرابط بشكل نصي صريح في نهاية الرسالة لكي يتمكن تيليجرام من توليد المعاينة (Preview) تلقائياً
  return [
    `عرض عقاري جديد | ${escapeHtml(title)}`,
    `النوع: ${escapeHtml(propertyType)} — ${escapeHtml(listingLabel)}`,
    `السعر: ${escapeHtml(priceValue)} ر.س${escapeHtml(priceSuffix)}`,
    area ? `المساحة: ${escapeHtml(area)}` : '',
    furnishingText(fields) ? `التأثيث: ${furnishingText(fields)}` : '',
    ...apartmentLines,
    city || district
      ? `الموقع: ${escapeHtml([city, district].filter(Boolean).join(' — '))}`
      : '',
    `المعلن: ${escapeHtml(advertiserName)}`,
    stringField(fields, 'publisher_phone') ? `الجوال: ${escapeHtml(limitText(stringField(fields, 'publisher_phone'), 20))}` : '',
    stringField(fields, 'publisher_email') ? `البريد: ${escapeHtml(limitText(stringField(fields, 'publisher_email'), 120))}` : '',
    serialNumber
      ? `رقم الإعلان: ${new Intl.NumberFormat('ar-SA', { useGrouping: false }).format(serialNumber)}`
      : '',
    `تفاصيل العقار: ${detailsUrl}`,
  ].filter(Boolean).join('\n');
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = parseBody(req.body);
  const propertyId = body?.propertyId;
  
  if (typeof propertyId !== 'string' || !propertyId) {
    return res.status(400).json({ error: 'Invalid property ID' });
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || 'durrattest';

  try {
    const firestoreUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/properties/${encodeURIComponent(propertyId)}`;
    const propertyResponse = await fetch(firestoreUrl);
    
    let fields: Record<string, FirestoreValue> = {};
    if (!propertyResponse.ok) {
      console.error('[telegram-notify] Could not read property from Firestore', propertyResponse.status, propertyId);
    } else {
      const property = await propertyResponse.json() as FirestoreDocument;
      fields = property.fields ?? {};
    }

    const message = buildMessage(fields, propertyId);

    // إرسال رسالة نصية مع السماح لمعاينة الرابط (Preview) بالظهور تلقائياً لتظهر صورة الموقع في الأسفل
    const isRent = isRentListing(fields);
    const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || FALLBACK_BOT_TOKEN;
    const sent = await sendTelegram(botToken, {
      chat_id: targetChatId(isRent),
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    });

    if (!process.env.TELEGRAM_BOT_TOKEN) console.error('[telegram-notify] TELEGRAM_BOT_TOKEN is not set in Vercel; using fallback token');
    if (!process.env[isRent ? 'TELEGRAM_RENT_CHAT_ID' : 'TELEGRAM_SALE_CHAT_ID']) console.error(`[telegram-notify] ${isRent ? 'TELEGRAM_RENT_CHAT_ID' : 'TELEGRAM_SALE_CHAT_ID'} is not set in Vercel; using fallback channel`);
    if (!sent.ok) {
      return res.status(502).json({ error: 'Telegram rejected the message', details: sent.detail, channel: isRent ? 'rent' : 'sale' });
    }

    return res.status(200).json({ sent: true, channel: isRent ? 'rent' : 'sale' });
  } catch (err) {
    console.error('[telegram-notify] Unexpected failure', err);
    return res.status(502).json({ error: 'Notification service unavailable', details: String(err) });
  }
}
