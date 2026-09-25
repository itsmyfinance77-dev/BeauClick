import { toMessageView } from './chat.controller';
import { ChatMessageEntity } from './entities/chat.entities';

/**
 * The participant projection of one message — #327.
 *
 * Two rules, both about who may learn what from a message the caller can
 * already read:
 *
 *   - `side` is the AUTHOR's side, identical for every reader. It used to be
 *     "the other side unless I wrote it", which labelled a business owner's view
 *     of their own manager's reply as the customer's.
 *   - no user id reaches the page. The customer talks to the business; which
 *     staff member typed a reply is not theirs to tell apart (`V32-DEC-010`).
 *
 * The real-PostgreSQL suite (`chat-message-projection.pg-spec.ts`) proves the
 * same through the real stack and a real business with two readers; this file
 * pins the function without booting anything.
 */

const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const OWNER = '00000000-0000-4000-8000-00000000b001';
const MANAGER = '00000000-0000-4000-8000-00000000b002';

function message(senderUserId: string | null, overrides: Partial<ChatMessageEntity> = {}): ChatMessageEntity {
  return Object.assign(new ChatMessageEntity(), {
    id: '00000000-0000-4000-8000-0000000000aa',
    conversationId: '00000000-0000-4000-8000-0000000000cc',
    customerUserId: CUSTOMER,
    senderUserId,
    body: senderUserId === null ? null : 'متن',
    erasedAt: senderUserId === null ? new Date('2026-09-01T00:00:00Z') : null,
    sequence: 3,
    idempotencyKey: 'client-key-0123456789',
    createdAt: new Date('2026-09-01T10:00:00Z'),
    ...overrides,
  });
}

describe('toMessageView — side is the author`s, for every reader', () => {
  it('labels a manager`s reply `seller` to the owner, who did not write it', () => {
    expect(toMessageView(message(MANAGER), OWNER)).toMatchObject({ side: 'seller', mine: false });
  });

  it('labels the same reply `seller` to the manager who wrote it, and to the customer', () => {
    expect(toMessageView(message(MANAGER), MANAGER)).toMatchObject({ side: 'seller', mine: true });
    expect(toMessageView(message(MANAGER), CUSTOMER)).toMatchObject({ side: 'seller', mine: false });
  });

  it('labels the customer`s own message `customer` to every reader, `mine` only to the customer', () => {
    expect(toMessageView(message(CUSTOMER), CUSTOMER)).toMatchObject({ side: 'customer', mine: true });
    expect(toMessageView(message(CUSTOMER), OWNER)).toMatchObject({ side: 'customer', mine: false });
    expect(toMessageView(message(CUSTOMER), MANAGER)).toMatchObject({ side: 'customer', mine: false });
  });

  it('gives an erased placeholder no side and no owner, rather than a guess', () => {
    for (const reader of [CUSTOMER, OWNER, MANAGER]) {
      expect(toMessageView(message(null), reader)).toMatchObject({ side: null, mine: false, body: null, erased: true });
    }
  });
});

describe('toMessageView — carries no user id', () => {
  it('has exactly the browser contract`s keys', () => {
    expect(Object.keys(toMessageView(message(MANAGER), OWNER)).sort()).toEqual(
      ['body', 'createdAt', 'erased', 'id', 'mine', 'sequence', 'side'].sort(),
    );
  });

  it('never contains the author`s, the customer`s or the reader`s id, nor the client`s idempotency key', () => {
    const serialised = JSON.stringify(toMessageView(message(MANAGER), OWNER));
    for (const secret of [MANAGER, CUSTOMER, OWNER, 'client-key-0123456789']) {
      expect(serialised).not.toContain(secret);
    }
  });
});
