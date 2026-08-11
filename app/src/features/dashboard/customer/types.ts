export interface MyOrder {
	id: number;
	number: string;
	status: string;
	total: number;
	date: string | null;
	itemCount: number;
	viewUrl: string;
}
