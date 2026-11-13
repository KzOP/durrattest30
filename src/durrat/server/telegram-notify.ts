import { propertyImages } from '@/durrat/lib/property-images';
// Ported from the original Vercel function. Sends new-listing notices to the rent/sale Telegram channels.
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


const TELEGRAM_CAPTION_LIMIT = 1024;
const MAX_TELEGRAM_IMAGES = 39;
const TELEGRAM_MEDIA_GROUP_LIMIT = 10;

const RENT_CHAT_ID = '@DurratAlHijraRealEstateOffice';
const SALE_CHAT_ID = '@DurratAlHijraRealEstateOffice11';
const DEFAULT_IMAGE = 'https://kommodo.ai/i/HyR58SlhDKy8AyuOuI8O';

type TelegramTarget = { botToken: string; chatId: string };

function telegramTargetFor(isRent: boolean): TelegramTarget {
  const env = process.env;
  const shared = (env.TELEGRAM_BOT_TOKEN || '').trim();
  const botToken = (isRent ? env.TELEGRAM_RENT_BOT_TOKEN : env.TELEGRAM_SALE_BOT_TOKEN)?.trim() || shared;
  return { botToken, chatId: isRent ? RENT_CHAT_ID : SALE_CHAT_ID };
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
  const westernDigits = value.trim()
    .replace(/[٠-٩۰-۹]/g, (digit) => {
      const arabicIndic = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
      return String(arabicIndic >= 0 ? arabicIndic : '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit));
    })
    .replace(/٬/g, ',')
    .replace(/٫/g, '.');
  const normalized = westernDigits.replace(/[,\s]/g, '');
  const number = Number(normalized);
  return westernDigits && Number.isFinite(number)
    ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(number)
    : westernDigits;
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
    return entities[character] ?? character;
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

function decodeField(value: FirestoreValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(decodeField);
  if (value.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields ?? {}).map(([key, item]) => [key, decodeField(item)]));
  return null;
}

export function listingImageUrls(fields: Record<string, FirestoreValue>) {
  return propertyImages(Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeField(value)])))
    .filter((url) => (isHttpsUrl(url) && !url.includes('durrattest23.vercel.app')) || /^data:image\//i.test(url));
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

type TelegramAttachment = { bytes: Uint8Array; mimeType: string; filename: string };
type PreparedTelegramImage = { source: string; attachmentName?: string; attachment?: TelegramAttachment };

function prepareTelegramImage(source: string, index: number): PreparedTelegramImage | null {
  if (!/^data:image\//i.test(source)) {
    return isHttpsUrl(source) ? { source } : null;
  }

  const match = source.match(/^data:(image\/[a-z0-9.+-]+)(?:;[a-z0-9=._-]+)*;base64,([a-z0-9+/_=-]+)$/i);
  if (!match) return null;

  try {
    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length) return null;
    const extension = mimeType.split('/')[1].replace(/[^a-z0-9]+/g, '') || 'jpg';
    return {
      source,
      attachmentName: `photo${index}`,
      attachment: { bytes: Uint8Array.from(bytes), mimeType, filename: `property-photo-${index + 1}.${extension}` },
    };
  } catch {
    return null;
  }
}

async function sendTelegram(
  botToken: string,
  method: 'sendPhoto' | 'sendMessage' | 'sendMediaGroup',
  payload: Record<string, unknown>,
  attachments?: Record<string, TelegramAttachment>,
): Promise<TelegramResult> {
  try {
    const request: RequestInit = { method: 'POST' };
    if (attachments && Object.keys(attachments).length) {
      const form = new FormData();
      for (const [key, value] of Object.entries(payload)) {
        form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
      }
      for (const [name, file] of Object.entries(attachments)) {
        form.append(name, new Blob([Uint8Array.from(file.bytes)], { type: file.mimeType }), file.filename);
      }
      request.body = form;
    } else {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify(payload);
    }
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, request);
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

function splitMediaGroups(images: string[]) {
  const groups: string[][] = [];
  let offset = 0;
  while (offset < images.length) {
    const remaining = images.length - offset;
    // Telegram requires 2–10 photos per group; avoid a one-photo final group.
    const size = remaining > TELEGRAM_MEDIA_GROUP_LIMIT && remaining - TELEGRAM_MEDIA_GROUP_LIMIT === 1
      ? TELEGRAM_MEDIA_GROUP_LIMIT - 1
      : Math.min(TELEGRAM_MEDIA_GROUP_LIMIT, remaining);
    groups.push(images.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

export function buildMessage(fields: Record<string, FirestoreValue>, propertyId: string, appUrl: string) {
  const westernizeDigits = (value: string) => value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndic = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
    return String(arabicIndic >= 0 ? arabicIndic : '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit));
  });
  const text = (keys: string[], limit = 80) => escapeHtml(limitText(westernizeDigits(firstTextField(fields, keys)), limit));
  const numeric = (keys: string[]) => escapeHtml(formatNumericText(firstTextField(fields, keys) || '0'));
  const rawPropertyType = stringField(fields, 'property_type');
  const propertyType = text(['property_type'], 60) || 'عقار';
  const normalizedPropertyType = normalizedLabel(rawPropertyType);
  const isLand = /(?:ارض|اراضي|land)/i.test(normalizedPropertyType);
  const isRent = isRentListing(fields);
  const period = rentPeriodFromFields(fields);
  const staffName = text(['publisher_name', 'created_by_name']) || 'غير محدد';
  const phone = text(['publisher_phone', 'contact_phone', 'created_by_phone']);
  const condition = stringField(fields, 'condition') || stringField(fields, 'property_condition');
  const conditionText = ['new', 'جديدة', 'جديد'].includes(condition) ? 'جديدة'
    : ['used', 'مستعملة', 'مستعمل'].includes(condition) ? 'مستعملة' : '';
  const price = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(numberField(fields, 'price'));
  const payment = text(['payment_method']) || (isRent ? period === 'two_installments' ? 'على دفعتين' : period === 'monthly' ? 'شهرياً' : 'سنوياً' : '');
  const insurance = numberField(fields, 'insurance_amount');
  const laundry = fields.has_laundry?.booleanValue === true || numberField(fields, 'laundry_rooms') > 0;
  const location = [text(['district'], 60), text(['street'], 100), text(['notes', 'description'], 240)].filter(Boolean).join(' - ');
  const rawArea = firstTextField(fields, ['area']);
  const parsedArea = formatNumericText(rawArea).replace(/,/g, '').match(/[-+]?\d+(?:\.\d+)?/);
  const area = parsedArea && Number(parsedArea[0]) > 0 ? escapeHtml(areaText(fields)) : '';
  const details = isLand
    ? (area ? [`المساحة: ${area}`] : [])
    : [
      `الدور: ${numeric(['floor_number', 'floor'])} — ${fields.has_elevator?.booleanValue === true ? 'يوجد مصعد' : 'لا يوجد مصعد'}`,
      `عدد الغرف: ${numeric(['rooms', 'bedrooms', 'bedroom_count'])}`,
      `عدد الصالات: ${numeric(['lounges', 'living_rooms', 'halls'])}`,
      `عدد دورات المياه: ${numeric(['bathrooms', 'bathroom_count', 'baths'])}`,
      `المطبخ: ${numeric(['kitchens', 'kitchen_count'])}`,
      ...(laundry ? ['غرفة الغسيل: يوجد'] : []),
    ];
  return [
    `${propertyType} ${isRent ? 'للإيجار' : 'للبيع'}`,
    ...(!isLand && conditionText ? [conditionText] : []),
    `رقم الإعلان: ${numeric(['serial_number'])}`,
    `المسؤول عن الإعلان: ${staffName}`,
    ...details,
    '',
    `المطلوب: ${price} ر.س${payment ? ` ${payment}` : ''}`,
    ...(!isLand && insurance > 0 ? [`مبلغ التأمين: ${new Intl.NumberFormat('en-US').format(insurance)} ر.س`] : []),
    `الموقع: (${location || text(['city'], 60)})`,
    '',
    'الموظف المسؤول عن الإعلان:',
    `للتواصل ${staffName}: ${phone || 'غير متوفر'}`,
    `<a href="${escapeHtml(`${appUrl}/?property=${encodeURIComponent(propertyId)}`)}">معاينة العقار على الموقع</a>`,
  ].join('\n');
}

export async function deliverListing(botToken: string, chatId: string, images: string[], message: string) {
  const errors: string[] = [];
  const imageSources = (images.length ? images : [DEFAULT_IMAGE]).slice(0, MAX_TELEGRAM_IMAGES);
  const orderedImages = imageSources.map(prepareTelegramImage).filter((image): image is PreparedTelegramImage => Boolean(image));
  if (orderedImages.length < imageSources.length) errors.push('One or more listing images could not be decoded');
  // Telegram captions allow 1024 parsed characters; preserve the complete template in a follow-up if longer.
  const parsedLength = message.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|#39);/g, 'x').length;
  const captionFits = parsedLength <= TELEGRAM_CAPTION_LIMIT;
  const caption = captionFits ? message : undefined;

  const sendPhoto = (image: PreparedTelegramImage, withCaption?: string) => {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      ...(withCaption ? { caption: withCaption, parse_mode: 'HTML' } : {}),
    };
    if (image.attachment) {
      return sendTelegram(botToken, 'sendPhoto', payload, { photo: image.attachment });
    }
    return sendTelegram(botToken, 'sendPhoto', { ...payload, photo: image.source });
  };
  const sendText = () => sendTelegram(botToken, 'sendMessage', {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  // Do not substitute the logo for a listing that had image data but could not be decoded.
  if (!orderedImages.length) {
    const text = await sendText();
    if (text.error) errors.push(text.error);
    return { ok: text.ok, method: 'sendMessage', errors };
  }

  if (orderedImages.length > 1) {
    let albumFailed = false;
    for (const [groupIndex, group] of splitMediaGroups(orderedImages).entries()) {
      const attachments: Record<string, TelegramAttachment> = {};
      const media = group.map((image, index) => {
        const attachmentName = image.attachment ? `photo${groupIndex}_${index}` : undefined;
        if (attachmentName && image.attachment) attachments[attachmentName] = image.attachment;
        return {
          type: 'photo',
          media: attachmentName ? `attach://${attachmentName}` : image.source,
          ...(groupIndex === 0 && index === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
        };
      });
      const album = await sendTelegram(botToken, 'sendMediaGroup', {
        chat_id: chatId,
        media,
      }, Object.keys(attachments).length ? attachments : undefined);
      if (!album.ok) {
        if (album.error) errors.push(album.error);
        albumFailed = true;
        break;
      }
    }
    if (!albumFailed && captionFits) return { ok: true, method: 'sendMediaGroup', errors };
    if (!albumFailed) {
      const text = await sendText();
      return { ok: text.ok, method: 'sendMediaGroup', errors: text.error ? [...errors, text.error] : errors };
    }
  }
  const photo = await sendPhoto(orderedImages[0], caption);
  if (photo.ok && captionFits) return { ok: true, method: 'sendPhoto', errors };
  if (photo.error) errors.push(photo.error);
  const text = await sendText();
  if (text.error) errors.push(text.error);
  return { ok: text.ok, method: 'sendMessage', errors };
}


const FIREBASE_PROJECT_ID = 'durratalhijarh';

export async function handleTelegramNotify(request: Request): Promise<Response> {
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const authHeader = request.headers.get('authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401);
  const body = parseBody(await request.text());
  const propertyId = body?.propertyId;
  if (typeof propertyId !== 'string' || !propertyId || propertyId.length > 128) {
    return json({ error: 'Invalid property ID' }, 400);
  }
  const projectId = process.env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT_ID;
  try {
    // Staff session check: the employee record is only readable by signed-in staff (Firestore rules).
    const firestoreBase = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const propertyResponse = await fetch(`${firestoreBase}/properties/${encodeURIComponent(propertyId)}`, {
      headers: { Authorization: authHeader },
    });
    if (propertyResponse.status === 401 || propertyResponse.status === 403) return json({ error: 'Unauthorized' }, 401);
    let fields: Record<string, FirestoreValue> = {};
    if (propertyResponse.ok) {
      fields = ((await propertyResponse.json()) as FirestoreDocument).fields ?? {};
    } else {
      return json({ error: 'Property not found' }, 404);
    }
    const bodyListingType = body?.listingType;
    if (bodyListingType === 'rent' || bodyListingType === 'sale') fields.listing_type = { stringValue: bodyListingType };
    const bodyRentPeriod = body?.rentPeriod;
    if (!fields.rent_period && typeof bodyRentPeriod === 'string') fields.rent_period = { stringValue: bodyRentPeriod };

    const appUrl = new URL(request.url).origin;
    const message = buildMessage(fields, propertyId, appUrl);
    const images = listingImageUrls(fields);
    const isRent = isRentListing(fields);
    const target = telegramTargetFor(isRent);
    const channelType = isRent ? 'rent' : 'sale';
    if (!target.botToken) return json({ error: 'Telegram is not configured', channel: channelType }, 503);
    const chatId = normalizeChatId(target.chatId);
    const delivery = await deliverListing(target.botToken, chatId, images, message);
    if (!delivery.ok) return json({ error: 'Telegram rejected the message', channel: channelType, chatId, details: delivery.errors }, 502);
    return json({ sent: true, method: delivery.method, channel: channelType });
  } catch (err) {
    return json({ error: 'Notification service unavailable', details: String(err) }, 502);
  }
}
