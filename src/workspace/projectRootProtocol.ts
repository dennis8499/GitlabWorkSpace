export interface ProjectFolder {
  uri: string;
  name: string;
  path: string;
}

export interface ProjectRootContext {
  folders: ProjectFolder[];
  selectedFolderUri?: string;
  root?: string;
  manual: boolean;
  revision: string;
  error?: string;
}

