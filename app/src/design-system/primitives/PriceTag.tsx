import { formatToman } from '@/lib/format';
import './PriceTag.css';

export function PriceTag( { amount, oldAmount, prefix }: { amount: number; oldAmount?: number; prefix?: string } ) {
	return (
		<span className="bc-price bc-numeric">
			{ prefix && <span className="bc-price__prefix">{ prefix }</span> }
			<span className="bc-price__amount">{ formatToman( amount ) }</span>
			<span className="bc-price__unit">تومان</span>
			{ typeof oldAmount === 'number' && oldAmount > amount && (
				<span className="bc-price__old">{ formatToman( oldAmount ) }</span>
			) }
		</span>
	);
}
