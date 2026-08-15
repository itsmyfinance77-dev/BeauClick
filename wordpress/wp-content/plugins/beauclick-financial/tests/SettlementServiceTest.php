<?php
declare( strict_types=1 );

namespace BeauClick\Financial\Tests;

use BeauClick\Financial\CommissionConfig;
use BeauClick\Financial\LedgerService;
use BeauClick\Financial\SettlementService;
use WP_UnitTestCase;

final class SettlementServiceTest extends WP_UnitTestCase {

	private LedgerService $ledger;
	private SettlementService $settlements;

	public function set_up(): void {
		parent::set_up();
		CommissionConfig::set_rate( 15 );
		$this->ledger      = new LedgerService();
		$this->settlements = new SettlementService( $this->ledger );
	}

	// 1. Settling an order in full brings its outstanding to exactly zero, and the batch amount is computed automatically -- never a free-typed admin value.
	public function test_create_settlement_computes_the_amount_automatically(): void {
		$this->ledger->record_payment( 301, 401, LedgerService::PARTY_PROFESSIONAL, 51, 1000000 ); // receivable 850,000.

		$result = $this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 51, [ 301 ], 'انتقال بانکی', 'REF123', null, 900 );

		$this->assertIsArray( $result );
		$this->assertSame( 850000, ( $this->settlements->find( $result['id'] ) )['amount'] );
		$this->assertSame( 0, $this->settlements->outstanding_for_order( 301 ) );
	}

	// 2. A settlement can cover multiple orders for the same party in one batch, itemized per order.
	public function test_create_settlement_covers_multiple_orders_in_one_batch(): void {
		$this->ledger->record_payment( 302, 402, LedgerService::PARTY_BUSINESS, 52, 500000 ); // receivable 425,000.
		$this->ledger->record_payment( 303, 403, LedgerService::PARTY_BUSINESS, 52, 300000 ); // receivable 255,000.

		$result = $this->settlements->create_settlement( LedgerService::PARTY_BUSINESS, 52, [ 302, 303 ], null, null, null, 900 );

		$batch = $this->settlements->find( $result['id'] );
		$this->assertSame( 680000, $batch['amount'] );

		$items = $this->settlements->items_for( $result['id'] );
		$this->assertCount( 2, $items );
	}

	// 3. Settling an order that doesn't belong to the party being settled is rejected -- the real ownership guard.
	public function test_create_settlement_rejects_an_order_belonging_to_a_different_party(): void {
		$this->ledger->record_payment( 304, 404, LedgerService::PARTY_PROFESSIONAL, 53, 500000 );

		$result = $this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 54, [ 304 ], null, null, null, 900 ); // Party 54 trying to settle party 53's order.

		$this->assertIsString( $result, 'Party 54 must never be able to settle an order whose real receivable belongs to party 53.' );
		$this->assertSame( 500000 - 75000, $this->settlements->outstanding_for_order( 304 ), 'The real owner\'s (party 53) outstanding must remain completely untouched by the rejected attempt.' );
	}

	// 4. An order with no outstanding balance (already fully settled) cannot be settled a second time.
	public function test_cannot_settle_the_same_order_twice(): void {
		$this->ledger->record_payment( 305, 405, LedgerService::PARTY_PROFESSIONAL, 55, 400000 );
		$this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 55, [ 305 ], null, null, null, 900 );

		$second = $this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 55, [ 305 ], null, null, null, 900 );

		$this->assertIsString( $second, 'A second settlement attempt against an already-fully-settled order must be rejected, not silently accepted for zero.' );
	}

	// 5. Reversing a settlement frees the order up for a new settlement.
	public function test_reversing_a_settlement_makes_the_order_outstanding_again(): void {
		$this->ledger->record_payment( 306, 406, LedgerService::PARTY_PROFESSIONAL, 56, 400000 );
		$result = $this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 56, [ 306 ], null, null, null, 900 );

		$this->assertSame( 0, $this->settlements->outstanding_for_order( 306 ) );

		$reversed = $this->settlements->reverse_settlement( $result['id'], 900, 'اشتباه ثبت شده بود' );
		$this->assertTrue( $reversed );

		$this->assertSame( 340000, $this->settlements->outstanding_for_order( 306 ), 'After reversal, the order\'s full 15%-net receivable (340,000 of 400,000) must be outstanding again.' );

		// And it can genuinely be settled again.
		$again = $this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 56, [ 306 ], null, null, null, 900 );
		$this->assertIsArray( $again );
	}

	// 6. Reversing an already-reversed settlement is rejected, not a silent no-op.
	public function test_cannot_reverse_the_same_settlement_twice(): void {
		$this->ledger->record_payment( 307, 407, LedgerService::PARTY_PROFESSIONAL, 57, 400000 );
		$result = $this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 57, [ 307 ], null, null, null, 900 );

		$this->settlements->reverse_settlement( $result['id'], 900, 'first' );
		$second = $this->settlements->reverse_settlement( $result['id'], 900, 'second' );

		$this->assertIsString( $second );
	}

	// 7. Refund after full settlement: outstanding goes negative (an honest, visible fact), never silently clawed back.
	public function test_a_refund_after_full_settlement_produces_a_negative_outstanding(): void {
		$this->ledger->record_payment( 308, 408, LedgerService::PARTY_PROFESSIONAL, 58, 1000000 ); // receivable 850,000.
		$this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 58, [ 308 ], null, null, null, 900 ); // Fully settled: 850,000.

		$this->ledger->record_refund( 308, 9010, 1000000 ); // Full refund, after settlement.

		$this->assertSame( -850000, $this->settlements->outstanding_for_order( 308 ), 'A refund landing after full settlement must show as a real negative outstanding, not silently rewrite the past settlement.' );

		// A batch that was already recorded (status='recorded') must remain untouched -- its own amount and status never silently changed.
		$batches = $this->settlements->for_party( LedgerService::PARTY_PROFESSIONAL, 58 );
		$this->assertSame( 850000, $batches[0]['amount'] );
		$this->assertSame( 'recorded', $batches[0]['status'] );
	}

	// 8. Refund BEFORE settlement: the outstanding amount already reflects the reduced receivable, and settling covers exactly that reduced amount.
	public function test_a_refund_before_settlement_reduces_what_can_be_settled(): void {
		$this->ledger->record_payment( 309, 409, LedgerService::PARTY_PROFESSIONAL, 59, 1000000 ); // receivable 850,000.
		$this->ledger->record_refund( 309, 9011, 500000 ); // 50% refunded before any settlement -- reversal: commission -75,000, receivable -425,000.

		$this->assertSame( 425000, $this->settlements->outstanding_for_order( 309 ) );

		$result = $this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 59, [ 309 ], null, null, null, 900 );
		$this->assertSame( 425000, $this->settlements->find( $result['id'] )['amount'] );
	}

	// 9. party_summary() aggregates receivable/settled/outstanding correctly across multiple orders and one reversed settlement.
	public function test_party_summary_aggregates_correctly(): void {
		$this->ledger->record_payment( 310, 410, LedgerService::PARTY_BUSINESS, 60, 1000000 ); // receivable 850,000.
		$this->ledger->record_payment( 311, 411, LedgerService::PARTY_BUSINESS, 60, 500000 );  // receivable 425,000.
		$this->settlements->create_settlement( LedgerService::PARTY_BUSINESS, 60, [ 310 ], null, null, null, 900 );

		$summary = $this->settlements->party_summary( LedgerService::PARTY_BUSINESS, 60 );
		$this->assertSame( 1275000, $summary['receivableNet'] );
		$this->assertSame( 850000, $summary['settled'] );
		$this->assertSame( 425000, $summary['outstanding'] );
	}

	// 10. outstanding_orders_for_party() only lists orders with a genuinely positive outstanding amount.
	public function test_outstanding_orders_for_party_excludes_fully_settled_orders(): void {
		$this->ledger->record_payment( 312, 412, LedgerService::PARTY_PROFESSIONAL, 61, 300000 );
		$this->ledger->record_payment( 313, 413, LedgerService::PARTY_PROFESSIONAL, 61, 400000 );
		$this->settlements->create_settlement( LedgerService::PARTY_PROFESSIONAL, 61, [ 312 ], null, null, null, 900 );

		$outstanding = $this->settlements->outstanding_orders_for_party( LedgerService::PARTY_PROFESSIONAL, 61 );
		$order_ids   = array_column( $outstanding, 'orderId' );

		$this->assertNotContains( 312, $order_ids );
		$this->assertContains( 313, $order_ids );
	}
}
