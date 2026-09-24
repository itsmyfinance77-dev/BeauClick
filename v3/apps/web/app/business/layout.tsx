'use client';

import type { ReactNode } from 'react';
import { SellerFrame } from '@/components/seller-frame';

/**
 * `/business` serves a professional managing their business and a visitor
 * registering one, so its frame depends on who is looking — see `SellerFrame`.
 */
export default function BusinessLayout({ children }: { children: ReactNode }) {
  return <SellerFrame>{children}</SellerFrame>;
}
