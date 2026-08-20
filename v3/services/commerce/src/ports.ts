/**
 * commerce-service's outbound ports.
 *
 * Same rationale as booking-service's: ADR-011 forbids `services/commerce`
 * importing `services/provider`, yet an order's price must come from the
 * professional's real service catalogue. The port is declared here and
 * implemented in `apps/api`.
 *
 * Note what the port deliberately does NOT offer: any way for a caller to
 * SUPPLY a price. The only price-shaped thing that crosses this boundary is
 * one the catalogue itself reports.
 */
export interface ServiceOfferingSnapshot {
  id: string;
  professionalId: string;
  name: string;
  priceToman: number;
  durationMinutes: number;
}

export interface ServiceCatalog {
  findServiceOffering(serviceId: string): Promise<ServiceOfferingSnapshot | null>;
}

export const SERVICE_CATALOG = Symbol('BEAUCLICK_SERVICE_CATALOG');
