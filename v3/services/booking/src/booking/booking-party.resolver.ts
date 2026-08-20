import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OwnerResolver } from '@beauclick/ownership';

import { BookingEntity, BookingActorType } from '../entities/booking.entity';
import { PROFESSIONAL_DIRECTORY, ProfessionalDirectory } from '../ports';

/**
 * A booking has TWO legitimate parties -- the customer who booked it and
 * the professional who will deliver it -- while `OwnershipGuard` compares a
 * single resolved owner id against the session.
 *
 * That is not a mismatch, because `OwnerResolver.resolve()` is handed the
 * session user id by design (its Phase 1 docblock exists precisely to
 * support indirect ownership). This resolver answers the question the guard
 * actually asks: "does this session have a legitimate ownership claim on
 * this resource?" -- returning the session's own id when it does, and null
 * when it does not. A stranger and a nonexistent booking both resolve to
 * null and therefore produce the identical NOT_FOUND_OR_NOT_YOURS response,
 * so booking ids stay non-enumerable.
 */
@Injectable()
export class BookingPartyResolver implements OwnerResolver<{ id: string }> {
  constructor(
    @InjectRepository(BookingEntity) private readonly bookings: Repository<BookingEntity>,
    @Inject(PROFESSIONAL_DIRECTORY) private readonly directory: ProfessionalDirectory,
  ) {}

  async resolve(sessionUserId: string, params: { id: string }): Promise<string | null> {
    return (await this.roleFor(params.id, sessionUserId)) ? sessionUserId : null;
  }

  /** The session's relationship to this booking, or null if it has none. */
  async roleFor(bookingId: string, sessionUserId: string): Promise<BookingActorType | null> {
    const booking = await this.bookings.findOne({ where: { id: bookingId } });
    if (!booking) return null;
    if (booking.customerId === sessionUserId) return 'customer';
    const ownerUserId = await this.directory.ownerUserIdFor(booking.professionalId);
    return ownerUserId && ownerUserId === sessionUserId ? 'professional' : null;
  }
}

/**
 * Narrower variant for routes only the professional may call (marking a
 * booking completed or a no-show). A customer holding a valid session for
 * their own booking resolves to null here -- correctly, since "it is my
 * booking" does not make it my call whether the service was delivered.
 */
@Injectable()
export class BookingProfessionalResolver implements OwnerResolver<{ id: string }> {
  constructor(private readonly party: BookingPartyResolver) {}

  async resolve(sessionUserId: string, params: { id: string }): Promise<string | null> {
    return (await this.party.roleFor(params.id, sessionUserId)) === 'professional' ? sessionUserId : null;
  }
}
