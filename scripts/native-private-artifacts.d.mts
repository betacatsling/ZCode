export function scanDisposable(dir: string, forbidden: string[], budget?: { files: number; bytes: number }, onFile?: (files: number) => void, deadlineAt?: number): Promise<void>;
export function assertAbsent(path: string): Promise<void>;
