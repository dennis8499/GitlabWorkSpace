export interface GitLabAccount {
  id: string;
  baseUrl: string;
  userId: number;
  username: string;
  name: string;
  needsLogin: boolean;
  group?: { id: number; fullPath: string };
}
