export interface GitLabUser {
  id: number;
  username: string;
  name: string;
}

export interface GitLabGroup {
  id: number;
  name: string;
  full_name?: string;
  full_path: string;
  web_url: string;
}

export interface GitLabProject {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  web_url: string;
  http_url_to_repo: string;
  default_branch?: string | null;
  namespace?: { full_path?: string; name?: string };
}

export interface GitLabIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description?: string | null;
  state: 'opened' | 'closed' | string;
  web_url: string;
  created_at?: string;
  updated_at?: string;
  assignees?: GitLabUser[];
  labels?: string[];
  author?: GitLabUser;
}

export interface GitLabMember {
  id: number;
  username: string;
  name: string;
  state?: string;
}
