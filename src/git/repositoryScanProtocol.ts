export interface ScannedRepository {
  path: string;
  name: string;
  remotes: string[];
  repositoryId?: string;
  registrationError?: string;
  projectIds?: number[];
}
export interface RepositoryScanState {
  status: 'idle' | 'scanning' | 'completed' | 'cancelled' | 'error';
  checkedDirectories: number;
  repositories: ScannedRepository[];
  errors: Array<{ path: string; message: string }>;
  excludes: string[];
}
