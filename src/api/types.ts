export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  avatar_url?: string | null;
  web_url?: string;
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
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
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
  assignee?: GitLabUser | null;
  closed_at?: string | null;
  closed_by?: GitLabUser | null;
  due_date?: string | null;
  start_date?: string | null;
  confidential?: boolean;
  discussion_locked?: boolean | null;
  subscribed?: boolean;
  issue_type?: string;
  milestone?: GitLabMilestone | null;
  time_stats?: GitLabTimeStats;
  task_completion_status?: { count: number; completed_count: number };
  references?: { short: string; relative: string; full: string };
  user_notes_count?: number;
  upvotes?: number;
  downvotes?: number;
  issue_link_id?: number;
  link_type?: 'relates_to' | 'blocks' | 'is_blocked_by';
}

export interface GitLabMember {
  id: number;
  username: string;
  name: string;
  state?: string;
}

export interface GitLabMilestone {
  id: number;
  iid?: number;
  title: string;
  state?: string;
  due_date?: string | null;
}

export interface GitLabLabel {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  description?: string | null;
}

export interface GitLabTimeStats {
  time_estimate: number;
  total_time_spent: number;
  human_time_estimate?: string | null;
  human_total_time_spent?: string | null;
}

export interface GitLabIssueNote {
  id: number;
  body: string;
  author: GitLabUser;
  created_at: string;
  updated_at?: string;
  system?: boolean;
  internal?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  type?: string | null;
}

export interface GitLabIssueDiscussion {
  id: string;
  individual_note?: boolean;
  notes: GitLabIssueNote[];
}

export interface GitLabEmojiReaction {
  id: number;
  name: string;
  user: GitLabUser;
}

export interface GitLabUpload {
  alt: string;
  url: string;
  markdown: string;
  full_path?: string;
}

export interface GitLabMetadata {
  version: string;
  revision?: string;
  enterprise?: boolean;
}

export interface GitLabMergeRequestSummary {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: string;
  web_url: string;
}

export interface GitLabTodo {
  id: number;
  state: string;
  target_type: string;
  target?: { id: number };
}

export interface GitLabIssueTemplate {
  name: string;
  content: string;
}
