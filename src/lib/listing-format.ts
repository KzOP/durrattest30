import type { Lang } from '@/lib/i18n';

export type RentPeriod = 'monthly' | 'annual' | 'two_installments';

const rentPeriodPriceText: Record<Lang, Record<RentPeriod, string>> = {
  ar: { monthly: 'شهرياً', annual: 'سنوياً', two_installments: 'على الدفعة الواحدة' },
  en: { monthly: '/ month', annual: '/ year', two_installments: 'per installment' },
};

const rentPeriodLabelText: Record<Lang, Record<RentPeriod, string>> = {
  ar: { monthly: 'شهري', annual: 'سنوي', two_installments: 'على دفعتين' },
  en: { monthly: 'monthly', annual: 'yearly', two_installments: '2 installments' },
};

export function formatPrice(price: number, listingType: string, rentPeriod?: RentPeriod, lang: Lang = 'ar') {
  const amount = lang === 'en'
    ? `SAR ${new Intl.NumberFormat('en-US').format(price)}`
    : new Intl.NumberFormat('ar-SA').format(price) + ' ر.س';
  if (listingType !== 'rent') return amount;
  return amount + ' ' + rentPeriodPriceText[lang][rentPeriod ?? 'annual'];
}

export function formatListingLabel(listingType: string, rentPeriod?: RentPeriod, lang: Lang = 'ar') {
  if (lang === 'en') {
    return listingType !== 'rent' ? 'For sale' : `For rent (${rentPeriodLabelText.en[rentPeriod ?? 'annual']})`;
  }
  if (listingType !== 'rent') return 'للبيع';
  return 'للإيجار (' + rentPeriodLabelText.ar[rentPeriod ?? 'annual'] + ')';
}
