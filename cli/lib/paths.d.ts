export interface RuntimePathOptions {
  home?: string;
  exists?: (path: string) => boolean;
}
export function runtimeDirs(root: string, options?: RuntimePathOptions): { configDir: string; dataDir: string };
