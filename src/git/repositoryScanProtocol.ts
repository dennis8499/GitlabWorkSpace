export interface ScannedRepository {
  path: string;
  name: string;
  remotes: string[];
  repositoryId?: string;
  registrationError?: string;
  projectIds?: number[];
}
export interface RepositoryScanState {
  status: 'idle' | 'scanning' | 'partial' | 'completed' | 'cancelled' | 'error';
  checkedDirectories: number;
  repositories: ScannedRepository[];
  errors: Array<{ path: string; message: string }>;
  excludes: string[];
  canResume?: boolean;
  remainingDirectories?: number;
  pausedReason?: string;
}
