/**
 * How an order's status is named on the receipt.
 *
 * Keys are the server's `ORDER_STATUSES` (`order.entity.ts`).
 * `order-status.spec.ts` reads that list and fails when the two drift, and an
 * unknown status shows a neutral word rather than the raw key — a receipt is
 * the one place a customer must never read an English enum.
 */
export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: 'در انتظار پرداخت',
  paid: 'پرداخت‌شده',
  partially_refunded: 'بازگشت جزئی وجه',
  refunded: 'بازگشت کامل وجه',
  cancelled: 'لغو شده',
  // V3.3 `#41b`. Deliberately not «رایگان» or «پرداخت‌شده»: nothing was
  // collected online, which is not the same as nothing being owed.
  online_collection_not_required: 'بدون پرداخت آنلاین',
  // V3.3 `#41c`. Deliberately not «پرداخت‌شده»: the online part is done,
  // which is not the same as the service being paid for in full.
  online_collection_completed: 'پرداخت آنلاین انجام شد',
};

/** For a status this client has never heard of. */
export const UNKNOWN_ORDER_STATUS_LABEL = 'نامشخص';

export function orderStatusLabel(status: string): string {
  return ORDER_STATUS_LABEL[status] ?? UNKNOWN_ORDER_STATUS_LABEL;
}
