export type NotificationLevel = 'info' | 'warn' | 'error';

export interface NotificationOrigin {
  accountId?: string;
  baseUrl?: string;
  groupId?: number;
  root?: string;
}

export interface WorkspaceNotification {
  id: string;
  level: NotificationLevel;
  title: string;
  messages: string[];
  createdAt: number;
  updatedAt: number;
  /** Changes only when published content changes, never for read/delete actions. */
  contentRevision: number;
  read: boolean;
  operationId?: string;
  origin?: NotificationOrigin;
}

export interface NotificationSnapshot {
  sessionId: string;
  revision: number;
  items: WorkspaceNotification[];
  unreadCount: number;
}

export type NotificationRequest =
  | { type: 'publishNotification'; level: NotificationLevel; message: string; title?: string; operationId?: string }
  | { type: 'markNotificationsRead'; ids: string[]; revision: number }
  | { type: 'markAllNotificationsRead'; revision: number }
  | { type: 'removeNotification'; id: string }
  | { type: 'clearNotifications'; revision: number };
