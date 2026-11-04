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

const PRODUCTION_APP_URL = 'https://durrattest25.vercel.app';
const TELEGRAM_CAPTION_LIMIT = 1024;

// القيم الاحتياطية (تُستخدم فقط إذا لم تُضبط متغيرات البيئة في Vercel)
const FALLBACK_BOT_TOKEN = '8976569747:AAGpQBVcgO-kBEc7FNW9KZdvzTvnE-PF1js';
const FALLBACK_CHAT_ID = '@durrattest';

type TelegramTarget = { botToken: string; chatId: string };

function telegramTargetFor(isRent: boolean): TelegramTarget {
  const env = process.env;
  const saleToken = (env.TELEGRAM_SALE_BOT_TOKEN || '').trim();
  const saleChat = (env.TELEGRAM_SALE_CHAT_ID || '').trim();
  const rentToken = (env.TELEGRAM_RENT_BOT_TOKEN || '').trim();
  const rentChat = (env.TELEGRAM_RENT_CHAT_ID || '').trim();
  if (isRent) {
    return {
      botToken: rentToken || saleToken || FALLBACK_BOT_TOKEN,
      chatId: rentChat || saleChat || FALLBACK_CHAT_ID,
    };
  }
  return {
    botToken: saleToken || rentToken || FALLBACK_BOT_TOKEN,
    chatId: saleChat || rentChat || FALLBACK_CHAT_ID,
  };
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
  const exact = stringField(fields, 'listing_type').trim().toLowerCase();
  if (exact === 'rent') return true;
  if (exact === 'sale') return false;
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

function isHttpsUrl(value: string) {
  if (!value || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function extractImageUrl(val: unknown): string {
  if (!val) return '';
  if (typeof val === 'string' && isHttpsUrl(val)) return val;
  if (typeof val === 'object' && val !== null) {
    const v = val as FirestoreValue;
    if (v.stringValue && isHttpsUrl(v.stringValue)) return v.stringValue;
    if (v.arrayValue?.values) {
      for (const item of v.arrayValue.values) {
        const found = extractImageUrl(item);
        if (found) return found;
      }
    }
    if (v.mapValue?.fields) {
      for (const key of Object.keys(v.mapValue.fields)) {
        const found = extractImageUrl(v.mapValue.fields[key]);
        if (found) return found;
      }
    }
  }
  return '';
}

function firstImageUrl(fields: Record<string, FirestoreValue>) {
  const imageKeys = [
    'image', 'imageUrl', 'image_url', 'imageURL', 
    'images', 'photos', 'imageUrls', 'photo', 'picture',
    'banner', 'thumbnail', 'media'
  ];
  for (const name of imageKeys) {
    if (fields[name]) {
      const url = extractImageUrl(fields[name]);
      if (url && !url.includes('durrattest23.vercel.app')) return url;
    }
  }
  for (const key of Object.keys(fields)) {
    const url = extractImageUrl(fields[key]);
    if (url && !url.includes('durrattest23.vercel.app')) return url;
  }
  // صورة افتراضية للعقار في حال لم يتم رفع صورة لضمان عدم فشل الإرسال أبداً
  return 'https://images.unsplash.com/photo-1560518883-ce09059eeffa';
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

type TelegramResult = { ok: boolean; error?: string };

async function sendTelegram(botToken: string, method: 'sendPhoto' | 'sendMessage', payload: Record<string, unknown>): Promise<TelegramResult> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; description?: string };
    if (response.ok && result.ok === true) return { ok: true };
    const error = `${method}: ${result.description || `HTTP ${response.status}`}`;
    console.error('Telegram error', error);
    return { ok: false, error };
  } catch (err) {
    const error = `${method}: ${String(err)}`;
    console.error('Telegram fetch failed', error);
    return { ok: false, error };
  }
}

function normalizeChatId(value: string) {
  const id = value.trim();
  if (!id) return id;
  return /^(@|-?\d)/.test(id) ? id : `@${id}`;
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

  return [
    `<b>🏡 عرض عقاري جديد | ${escapeHtml(title)}</b>`,
    `النوع: ${escapeHtml(propertyType)} — ${escapeHtml(listingLabel)}`,
    `السعر: ${escapeHtml(priceValue)} ر.س${escapeHtml(priceSuffix)}`,
    area ? `المساحة: ${escapeHtml(area)}` : '',
    ...apartmentLines,
    city || district
      ? `الموقع: ${escapeHtml([city, district].filter(Boolean).join(' — '))}`
      : '',
    `المعلن: ${escapeHtml(advertiserName)}`,
    serialNumber
      ? `رقم الإعلان: ${new Intl.NumberFormat('ar-SA').format(serialNumber)}`
      : '',
    `<a href="${escapeHtml(detailsUrl)}">معاينة العقار على الموقع</a>`,
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
    const authHeader = req.headers.authorization;
    const propertyResponse = await fetch(firestoreUrl, {
      headers: typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? { Authorization: authHeader }
        : {},
    });

    let fields: Record<string, FirestoreValue> = {};
    if (propertyResponse.ok) {
      const property = await propertyResponse.json() as FirestoreDocument;
      fields = property.fields ?? {};
    } else {
      console.error('Firestore read failed', propertyResponse.status);
    }

    // نوع الإعلان المرسل من الموقع له الأولوية لضمان التوجيه الصحيح
    const bodyListingType = body?.listingType;
    if (bodyListingType === 'rent' || bodyListingType === 'sale') {
      fields.listing_type = { stringValue: bodyListingType };
    }
    const bodyRentPeriod = body?.rentPeriod;
    if (!fields.rent_period && typeof bodyRentPeriod === 'string') {
      fields.rent_period = { stringValue: bodyRentPeriod };
    }

    const message = buildMessage(fields, propertyId);
    const imageUrl = firstImageUrl(fields);

    // اختيار البوت والقناة حسب نوع الإعلان (بيع / إيجار)
    const isRent = isRentListing(fields);
    const target = telegramTargetFor(isRent);
    const botToken = target.botToken;
    const chatId = normalizeChatId(target.chatId);
    const channelType = isRent ? 'rent' : 'sale';
    const errors: string[] = [];

    // إرسال الصورة في الأعلى ومعها تفاصيل الشقة الكاملة كـ caption
    if (imageUrl && message.length <= TELEGRAM_CAPTION_LIMIT) {
      const photoResult = await sendTelegram(botToken, 'sendPhoto', {
        chat_id: chatId,
        photo: imageUrl,
        caption: message,
        parse_mode: 'HTML',
      });
      if (photoResult.ok) {
        return res.status(200).json({ sent: true, method: 'sendPhoto', channel: channelType });
      }
      if (photoResult.error) errors.push(photoResult.error);
    }

    // بديل احتياطي إذا حدثت مشكلة في الصورة
    const textResult = await sendTelegram(botToken, 'sendMessage', {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    if (!textResult.ok) {
      if (textResult.error) errors.push(textResult.error);
      return res.status(502).json({
        error: 'Telegram rejected the message',
        channel: channelType,
        chatId,
        details: errors,
      });
    }

    return res.status(200).json({ sent: true, method: 'sendMessage', channel: channelType });
  } catch (err) {
    return res.status(502).json({ error: 'Notification service unavailable', details: String(err) });
  }
}
