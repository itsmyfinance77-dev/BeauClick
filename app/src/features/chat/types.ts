export interface ConversationSummary {
	id: number;
	type: string;
	otherUserId: number;
	otherUserName: string;
	lastMessageAt: string | null;
	lastMessage: string;
	unreadCount: number;
}

export interface ChatMessage {
	id: number;
	conversationId: number;
	senderId: number | null;
	body: string;
	createdAt: string;
	readAt: string | null;
}
